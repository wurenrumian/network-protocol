# DNS · protocol

## 问题定义

DNS 要解决的根本问题是：**如何在一个不需要全网同步、任何节点都可能离线或伪造的分布式命名空间中，把域名确定性地映射到资源记录。**

它明确不负责：

- 不提供名称到"真实世界实体"的证明——**DNSSEC 验证完整性，不验证权威性来源的正当性**；
- 不做内容审查/过滤（那是本地配置层的事，Unbound 以 local-zones 实现，不属协议本体）；
- 不保证强一致性——TTL 机制明确允许陈旧结果在一段时间内被复用；
- 不做路由或寻址决策，只产出 `name → resource records` 的映射（A/AAAA/NS/CNAME/...）。

### 为什么是分布式、逐级委派，而不是集中式目录

把"一个集中权威"换成"root → TLD → authoritative 的委派树"，用三笔代价换三点收益：

- **代价 1**：解析过程变成多跳迭代，需要缓存、超时、重试机制（这是本模块 `state-machine.md` 的主体）；
- **代价 2**：权威数据被切成碎片，客户端必须自行收集，增加了多种失败模式（lame、referral 循环、glue 缺失）；
- **代价 3**：权威方无法感知全局，变更只能靠 TTL 慢慢传播。

- **收益 1**：单点故障被隔离——只有你名字所在的 zone 的权威服务器挂了才影响你；
- **收益 2**：负载分散——每级 zone 独立运营、独立扩容；
- **收益 3**：管理自治——DNS 不依赖一个统一注册库之外的任何同步机制。

Unbound 作为**递归 resolver**，站在客户端与权威服务器之间：它代客户端完成迭代（RD 位），并用缓存吸收重复查询。

## 抽象对象

- **消息（DNS Message）**：一次查询/应答的最小载体，`sldns_buffer` 中的字节流 ↔ `struct msg_parse`（`util/data/msgparse.c`）。包含 header + 四个 section。
- **RR（Resource Record）**：`name, type, class, TTL, rdata` 五元组。单条记录。
- **RRset（Resource Record Set）**：**同一 name+type+class、且 rdata 互不相同**的一组 RR 的集合。**DNS 的语义单位是 RRset，不是单条 RR**——权威服务器以 RRset 为单位签名（RRSIG 覆盖整个 RRset），缓存也以 RRset 为单位存储（`packed_rrset_data`）。
- **缓存表**：
  - **消息缓存（message cache）**：以 `query_info + flags` 为键，缓存**完整的应答消息**（`reply_info`，含四段 RRset 引用），命中后可直接回给客户端。`services/cache/dns.c`。
  - **RRset 缓存（rrset cache）**：以 `name/type/class` 为键的独立 RRset 池，消息缓存引用它，**多个消息可共享同一 RRset**。`services/cache/rrset.c`。
  - **infra cache**（未复制）：记录每个上游服务器的 RTT/EDNS 能力/lame 标记，用于目标选择。
  - **neg cache / validation cache**（未复制，validator 模块）：负缓存与 DNSSEC 证明缓存。
- **委派点（delegation point, delegpt）**：解析推进的"当前位置"，包含 zone 名、NS 列表、A/AAAA 地址（glue）、`has_parent_side_NS` 等标记。在 `iterator/iterator.c` 中由 `delegpt_from_message()` 从 referral 或缓存构造。
- **迭代状态（iter_qstate）**：一次查询的模块状态，含 `state`/`final_state`、`qchase`（当前要追的 qname）、`dp`（当前委派点）、各类计数器（`referral_count`、`sent_count`、`query_restart_count`、`timeout_count`、`depth`）。

## wire format

### 头部（12 字节固定）

| 字段 | 长度 | 说明 |
|---|---|---|
| ID | 2B | 事务 ID，查询-应答匹配；随机化防缓存投毒（Unbound 还做 0x20 大小写随机化） |
| QR | 1 bit | 0=查询，1=应答 |
| Opcode | 4 bit | 0=QUERY，其他为 NOTIFY/UPDATE 等 |
| AA | 1 bit | 权威应答 |
| TC | 1 bit | 截断（UDP 放不下，需走 TCP） |
| RD | 1 bit | 期望递归 |
| RA | 1 bit | 递归可用 |
| Z | 1 bit | 保留，必须 0 |
| AD | 1 bit | 应答经过 DNSSEC 验证（authentic data） |
| CD | 1 bit | 校验关闭（checking disabled，客户端要求不验证） |
| RCODE | 4 bit | 0=NOERROR, 2=SERVFAIL, 3=NAMError/NXDOMAIN, 1=FORMERR, 5=REFUSED |

扩展 RCODE 的低 4 bit 在头中，高 8 bit 在 EDNS OPT 中（EDNS_RCODE_BADVERS）。

### 四段式 section

| Section | 计数字段 | 内容 |
|---|---|---|
| Question | QDCOUNT | 查询问题（QNAME/QTYPE/QCLASS），应答里回显 |
| Answer | ANCOUNT | 命中的 RRset |
| Authority | NSCOUNT | 委派/负应答（SOA）/权威 NS |
| Additional | ARCOUNT | glue（NS 的地址）、EDNS OPT |

应答中 Answer 命中、但 Authority/Additional 只允许出现与应答相关的记录——Unbound 的 `scrub_message()`（在 `iter_scrub.c`，未复制）会丢弃无关记录，防止缓存投毒经 Additional 注入。

### name 压缩

- 名字按 label 长度前缀编码，每段 `0x3F` 上限 63 字节，整名 ≤ 255 字节。
- **指针压缩**：`0xC0` 高位标记指向报文内偏移，指向前文出现的相同后缀。这使名字在报文中只存一次。
- 解析器必须**限制解压深度与跳转**（`pkt_dname_len()` 在 `msgparse.c` 中校验剩余字节），防止 `0xC0` 循环构造的畸形包；Unbound 对压缩指针有迭代限制，超限判 FORMERR。

### 类型 / 类

- 类型：A(1)、NS(2)、CNAME(5)、SOA(6)、PTR(12)、MX(15)、TXT(16)、AAAA(28)、SRV(33)、**DNSKEY(48)、DS(43)、RRSIG(46)、NSEC(47)、NSEC3(50)**、OPT(41, 仅 EDNS)。
- 类：IN(1)、CH(3)、HS(4)、ANY(255)；qclass=ANY 时 Unbound 对每个类发起查询并合并（`COLLECT_CLASS_STATE`）。
- 类型/类码点分配：IANA 分配码点；未识别类型由解析器按 rdata 长度跳过（`skip_pkt_rr()`），保证前向兼容。

### EDNS（RFC 6891）

- 以 **Additional 段中的伪记录 OPT**（type 41）承载：class 字段放 UDP payload 大小、TTL 字段放 ext-rcode/版本/DO 位、rdata 放选项列表（TLV：code/len/data）。
- DO 位：请求应答携带 DNSSEC 记录（client 必须设 DO 才收到 RRSIG 等）。
- Unbound 在 `worker_handle_request()` 中解析并校验 EDNS：`edns_version != 0 → BADVERS`、`udp_size` 下限 512（`harden_short_bufsize` 时忽略过小值）、上限受 `max-udp-size` 约束；不支持 EDNS 的旧服务器通过渐进降级（EDNS 协商）处理。

## 核心机制

### 1. 递归解析（iterative resolution，RFC 1034 §4.3.2）

RD=1 的查询进入迭代器。算法骨架（RFC 1034 Resolver Algorithm）：

1. **找本地数据/缓存**：查消息缓存；命中 CNAME 则追查并重启查询；命中最终答案则直接返回；
2. **找"最优"服务器**：从 qname 起，在缓存中找最近的委派点（NS RRset）；没有则**启动 root 预置（prime）**（`prime_root()`，用 root hints 发 NS 查询）；
3. **向下推进**：向当前委派点的 NS 地址发查询；
4. **按应答分类推进**：
   - ANSWER → 存缓存、返回；
   - REFERRAL → 把新委派点设为 `iq->dp`，回 `QUERYTARGETS_STATE` 继续（`referral_count++`）；
   - CNAME → 改追 qname 重新 `INIT_REQUEST_STATE`（`query_restart_count++`）；
   - LAME/REC_LAME/THROWAWAY → 换下一个目标；
   - 超时 → 换目标，重试；
5. **最后手段**：目标耗尽时向**父级**再取父侧 NS/glue（`processLastResort()`），或 SERVFAIL。

### 2. 迭代与目标选择

- 每个委派点有多个 NS 地址（`delegpt_addr`，含 RTT/attempts 状态）。`iter_server_selection()` 按 RTT 与失败惩罚排序选择；
- **glue 缺失**：委派点的 NS 没有 A/AAAA 时，发起目标查询（target query，子查询）先解析 NS 的地址；结果经 `iter_inform_super()` 回调回到父查询（`processTargetResponse()`）；
- 计数器硬限：`MAX_REFERRAL_COUNT`(130)、`MAX_SENT_COUNT`(32)、`MAX_RESTART_COUNT`(11)、`MAX_TARGET_NX`(5)、`MAX_TARGET_COUNT`(64) 等，超限即 SERVFAIL（`iterator.h` 定义，防止 CNAME 环/委派环死循环）。

### 3. 缓存

- **TTL 语义**：RRset 以"剩余相对 TTL"存于 `packed_rrset_data`，`*env->now` 随时间推移校验过期；消息缓存条目 TTL 取各 RRset 最小 TTL（`reply_info_set_ttls` + `dns_cache_store_msg`）。
- **两级结构**：`dns_cache_store()` 先按 referral/answer 分别 `rrset_cache_update()` 存 RRset，再把组装好的 `reply_info` 经 `slabhash_insert` 存入消息缓存；`dns_cache_lookup()` 先查消息缓存，未命中再 `find_closest_of_type` 做 DNAME/CNAME 合成。
- **负缓存**：NXDOMAIN/NODATA 由 SOA 的负 TTL 决定（RFC 2308）。Unbound 的 neg cache（`val_neg.c`，未复制）存储并验证负证明（NSEC/NSEC3）。
- **SERVFAIL 缓存**：`msg_del_servfail()`——TTL 0 的真应答到来时删除缓存中的 SERVFAIL，避免被"假死"应答污染。
- **过期复用**：`serve-expired` 配置在过期后继续回旧数据并后台刷新（`prefetch` / `reply_and_prefetch()`）。

### 4. 委派

- 权威服务器对"它不权威的名字"返回 **referral**：Authority 段带下一级 zone 的 NS 记录，Additional 段带 NS 的 glue 地址；
- 迭代器把 referral 变成新的委派点（`delegpt_from_message()`），继续向新 NS 查询；
- **父侧 NS（parent-side NS）**：`processLastResort()` 在目标耗尽时从父级拿 NS/glue（`iter_lookup_parent_NS_from_cache` / 重新向上查询），防止"无 glue 且缓存无地址"的死胡同。

### 5. DNSSEC 验证（RFC 4033–4035）

验证在 validator 模块（未复制），iterator 只负责**把验证需要的记录带回来**：

- `dnssec_expected`：当委派点处于信任锚之下或缓存有 DS 时，要求应答带 RRSIG（`iter_indicates_dnssec()`）；
- **信任链**：root 锚的 DNSKEY → 验证 TLD 的 DS → TLD 的 DNSKEY → ... → 目标 zone 的 RRSIG。DS 记录连接父子 zone；
- `DO 位`与 `CD 位`：查询带 DO 请求签名记录；CD 请求"跳过验证"，AD 声明"验证通过"；
- **NSEC/NSEC3**：用于负应答的完整性证明（证明某名字/类型确实不存在）；
- 验证失败 → `sec_status_bogus`，应答降级为 SERVFAIL（并缓存黑名单）。

### 6. 负缓存与 harden

- 负应答（NXDOMAIN / NOERROR-NODATA）按 SOA TTL 缓存；
- `harden-below-nxdomain`：对中间 NXDOMAIN 发起子查询做 DNSSEC 验证（`generate_sub_request` + `harden_below_nxdomain`），防止"先验的"未签名 NXDOMAIN 污染下域；
- `harden-referral-path`：验证委派路径上的 NS 记录，防伪造 referral。

## 设计取舍

| 取舍 | 选择 | 代价 / 收益 |
|---|---|---|
| 递归 vs 非递归 | Unbound 是**递归 resolver**；BIND 可同时做权威 | 代客户端迭代：客户端只需一个 RD 查询；resolver 承担状态/超时/缓存复杂度 |
| 消息缓存 + RRset 缓存两级 | 消息缓存快速整答；RRset 缓存跨消息复用 | 内存多一份索引；换取 cache 命中率与 CNAME 追查灵活性 |
| 迭代式状态机 | 显式状态枚举 + `process*State` 函数 + 计数器 | 超时/重试/边界清晰可审计；代价是代码较长 |
| 0x20 大小写随机化 + 随机 ID | 防缓存投毒（Kaminsky 攻击） | 每查询随机化 ID 与大小写；0x20 与 DNSSEC 相比只是廉价加固 |
| QNAME minimization | 只向权威逐 label 暴露查询名（RFC 9156） | 降低隐私泄露与缓存窥探；增加查询轮数（`MAX_MINIMISE_COUNT`） |
| 请求合并 | mesh 把相同查询去重（`mesh_new_client`），依赖数据带 outbound 引用计数 | 减少上游负载；代价是处理"共享子查询失败/超时"的复杂回调 |
| 安全考虑 | 强制校验请求格式（`worker_check_request`）、丢弃含 QR/异常 TC 的包 | 防反射放大与畸形包；代价是要求严格实现 |

## 不变量

1. **RRset 是缓存与签名的原子单位**：不会出现"同一 name/type/class 的半个 RRset"在缓存中。
2. **查询 ID 必须回显**：应答 ID ≠ 查询 ID 视为不匹配（Unbound 内层由 outside_network 校验，未复制文件）。
3. **委派只向下走**：referral 只指向 qname 的**严格子域**，否则视为 lame/非法（scrub 强制）。
4. **缓存 TTL 单调递减**：`*env->now` 单调推进，`packed_rrset_ttl_add()` 只在入库时一次性加上 `env->now`，查询时不再加。
5. **QNAME 追查单调**：CNAME 追查必须落在严格子域或循环计数递增，`MAX_RESTART_COUNT` 封顶。
6. **任何计数封顶必须终止**：referral/sent/restart/timeout/target-nx 全部有上限，迭代器在有限步内必返回（应答或 SERVFAIL）。
7. **消息缓存条目 TTL ≤ 其任一 RRset TTL**：过期 RRset 不参与整答。
8. **scrub 后应答只含与查询相关的记录**：Additional/Authority 注入的无关记录必须被删除。

## 边界条件与异常处理

- **报文边界**：
  - 报文 < 12 字节 → 丢弃（`worker_check_request` 返回 -1）；
  - QDCOUNT > 1 → FORMERR（`parse_query_section`）；
  - name 压缩指针越界/循环 → FORMERR/丢弃（`pkt_dname_len` 限制）；
  - 截断（TC）：UDP 应答放不下 → 置 TC，客户端转 TCP 重试；迭代器对 TCP 上游清除 TC（`iq->response->rep->flags &= ~BIT_TC`）。
- **上游失败**：
  - 超时：`timeout_count++`，回 `QUERYTARGETS_STATE` 换目标；连续超时（≥3）触发 0x20 fallback（`use_caps_bits_for_id`）；QNAME minimization 下 `MAX_MINIMISE_TIMEOUT_COUNT`(3) 后放弃最小化；
  - lame：标记 `infra_set_lame()`，目标被降权；最终仍无可用目标 → SERVFAIL；
  - 解析失败/scrub 失败：`parse_failures++` / `scrub_failures++`，丢弃该应答，换目标。
- **循环防护**：CNAME 环 → `MAX_RESTART_COUNT`；委派环 → `MAX_REFERRAL_COUNT`；目标过多 → `MAX_SENT_COUNT`、`MAX_TARGET_COUNT`；深度过深 → `max_dependency_depth`（`MAX_DEPENDENCY_DEPTH`）。
- **负应答**：NXDOMAIN 不可信的中间态需要验证（`harden-below-nxdomain`）；未签名的负应答在需要验证时只能 SERVFAIL。
- **EDNS**：bad version → BADVERS；udp_size 过小（<512）→ 忽略或 FORMERR；过大的请求在 `harden-large-queries` 下丢弃。
- **非递归查询（RD=0）**：只允许缓存窥探（`acl_allow_snoop`），否则 REFUSED；RD=0 时从缓存返回缓存委派消息（`answer_norec_from_cache`）。
- **权威 vs 缓存一致性**：referral 只在 `harden-referral-path` 条件下缓存；NS 记录用 `qstarttime` 而非 `env->now + leeway` 存 TTL（`dns_cache_store` 注释），防止过期委派污染。