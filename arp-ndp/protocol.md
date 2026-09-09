# ARP / IPv6 NDP · protocol

## 问题定义

IP 是网络层编址，Ethernet 帧携带 MAC 地址。主机要把一个 IP 数据报从本机网卡发到同一个二层网段上的下一跳（对端主机或网关），必须先把目的 IP 映射为 48-bit MAC 地址——这个映射**不在** IP 协议本身里。

要解决的核心问题（ARP 与 NDP 共同的问题）：

- **解析**：给定目的 IP，如何得到同链路节点的 MAC。
- **缓存**：解析结果如何存放、何时失效——解析是有代价的（至少一次广播往返），不应每次发包都做。
- **更新**：节点 MAC 变化（网卡替换、虚拟机迁移、网关 failover）后，陈旧映射如何被纠正。
- **防伪/防占用**：如何避免（或减弱）地址冲突与欺骗——ARP 基本不设防，NDP 通过 DAD 与 SEND 保护缓解。
- **撤销**：节点消失或地址被回收后，映射如何被清理并重新解析。

ARP 与 NDP 的分工差异：

| 维度 | ARP (IPv4) | NDP (IPv6) |
| --- | --- | --- |
| 报文承载 | 独立的以太网类型 0x0806 | ICMPv6 类型 135/136/133/134/137（受 ICMPv6 校验保护） |
| 寻址能力 | 只做地址解析 | 解析 + 路由器发现 + 前缀发现 + 重定向 + 不可达检测 + DAD |
| 状态模型 | 简单表项（EMPTY/PENDING/STABLE） | 显式邻居状态机（RFC 4861 §7.3） |
| 可达性维护 | 仅凭使用触发，无探测状态 | STALE/DELAY/PROBE 三级探测（NUD） |
| 地址冲突检测 | 无（借 DHCP/autoIP 侧信道） | 内置 DAD（tentative 地址 + NS/NA） |
| 依赖 | 仅 Ethernet 等广播介质 | 依赖链路本地地址与多播（solicited-node 多播组） |

NDP 不在 IPv6 上复用 ARP 的历史原因：ARP 无确认、无状态、易被劫持；且 IPv6 地址更大、链路本地地址的存在使"解析"可以更精细（仅请求 33:33 前缀的 solicited-node 多播组，而非全链路广播）。RFC 4861 明确 NDP 是 ARP 的替代设计，并把 ICMPv6 作为安全与校验的基础层。

## 抽象对象

### ARP 缓存表项（lwIP `struct etharp_entry`）

`src/core/ipv4/etharp.c` 中 `static struct etharp_entry arp_table[ARP_TABLE_SIZE]`（默认 10 项）是一个**固定数组**，每项含：

- `ipaddr`：目的 IPv4 地址（表键）。
- `ethaddr`：解析出的 48-bit MAC（`struct eth_addr`）。
- `state`：生命周期状态（EMPTY / PENDING / STABLE / STABLE_REREQUESTING_1/2 / STATIC）。
- `ctime`：自上次使用/解析以来的秒数（由 `etharp_tmr()` 每秒递增，用于老化与"到期前重请求"）。
- `netif`：关联网卡（支持多接口隔离，见 `ETHARP_TABLE_MATCH_NETIF`）。
- `q`：PENDING 期间排队等待解析的 IP 报文（单包或队列，取决于 `ARP_QUEUEING`）。

**PENDING 的语义**：表项存在（`ipaddr` 已知）但 `ethaddr` 尚无——等待一个 REPLY 才能把排队的 IP 数据报发出。这正是"解析是异步的"在数据结构上的体现。

### 邻居缓存（lwIP `struct nd6_neighbor_cache_entry`）

`src/core/ipv6/nd6.c` 中 `neighbor_cache[]`（默认 `LWIP_ND6_NUM_NEIGHBORS` = 10 项），每项：

- `next_hop_address`：下一跳 IPv6 地址（可能不是最终目的地，而是默认路由器）。
- `lladdr`：链路层地址（`NETIF_MAX_HWADDR_LEN` 字节）。
- `state`：RFC 4861 §7.3 状态（`ND6_NO_ENTRY/INCOMPLETE/REACHABLE/STALE/DELAY/PROBE`）。
- `isrouter`：本邻居是否同时是默认路由器（保护其不被轻易回收）。
- `counter`：联合体，按状态复用——`reachable_time`（REACHABLE 剩余秒数）、`delay_time`（DELAY 剩余 tick）、`probes_sent`（INCOMPLETE/PROBE 已发 NS 数）、`stale_time`（STALE 累计时间）。
- `q`：INCOMPLETE 期间排队待发的 IPv6 报文。
- `netif`：所属网卡。

### 支撑对象（NDP 独有）

- **目标缓存 `destination_cache[]`**：目的 IPv6 地址 → 下一跳地址 + PMTU，缓存路由决策，避免每包重做最长前缀匹配与路由器选择。
- **默认路由器表 `default_router_list[]`**：由 RA 报文填充，含 `neighbor_entry` 指针（关联到邻居缓存）、`invalidation_timer`（Router Lifetime）、`flags`（preference）。邻居缓存项与路由器表通过指针连接——路由器也是邻居。
- **on-link 前缀表 `prefix_list[]`**：由 RA 的 Prefix Information option 填充，用于判定某地址是否在本链路，从而决定"直接解析"还是"交给默认路由器"。
- **地址状态（DAD 专用）**：每个 netif 的 IPv6 地址有一组状态位（`IP6_ADDR_TENTATIVE`/`_1.._7`、`IP6_ADDR_VALID`/`PREFERRED`/`DEPRECATED`、`IP6_ADDR_DUPLICATED`），记录 DAD 进度。lwIP 用 `netif_ip6_addr_state(netif, i)` 读取。

## wire format

### ARP 报文（RFC 826，Ethernet 承载，`struct etharp_hdr`）

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         hwtype              |          proto                  |  2+2
|   hwlen     |   protolen   |            opcode               |  1+1+2
|            shwaddr          (6 bytes)  ...                    |  6
|            sipaddr          (4 bytes)  ...                    |  4
|            dhwaddr          (6 bytes)  ...                    |  6
|            dipaddr          (4 bytes)  ...                    |  4
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

固定 28 字节（`SIZEOF_ETHARP_HDR`）。字段（均按网络字节序，lwIP 中 `PP_HTONS`）：

- `hwtype`=1（Ethernet）、`proto`=0x0800（IPv4）。
- `hwlen`=6、`protolen`=4：使协议可被泛化为任意地址族（RFC 826 的本意）。
- `opcode`：1=REQUEST，2=REPLY。
- `shwaddr/sipaddr`：发送者 MAC/IP（REQUEST 中始终有效）。
- `dhwaddr/dipaddr`：REQUEST 中 `dhwaddr` 可为全零、`dipaddr` 是待解析目标；REPLY 中两者都应填对方值。

lwIP 解析时先校验 hwtype/hwlen/protolen/proto（不匹配直接丢，`etharp_input` 开头），再按 `opcode` 分派。

### NDP 报文（ICMPv6 承载，`struct ns_header` 等）

所有报文共享 ICMPv6 头：`type/code/chksum`。校验由 ICMPv6 伪头部校验覆盖（lwIP `ip6_chksum_pseudo`），这正是 NDP 相对 ARP 的加固点之一。

**NS（Neighbor Solicitation, type 135）**——`struct ns_header`：

```
| type=135 | code=0 | chksum |
|           reserved           |
|        target_address        (16 bytes)
| options...（Source/Target LLADDR）
```

用途：① 发起地址解析（目的 = 目标地址的 solicited-node 多播组）；② 不可达检测（单播 NS）；③ DAD 探测（源 = `::`）。

**NA（Neighbor Advertisement, type 136）**——`struct na_header`：

```
| type=136 | code=0 | chksum |
| R | S | O |     reserved    |
|        target_address       |
| options...（Target LLADDR）
```

- **R**（Router）：发送者自己是路由器（lwIP `ND6_FLAG_ROUTER` 0x80）。
- **S**（Solicited）：回应单播 NS 时置 1（`ND6_FLAG_SOLICITED` 0x40）。
- **O**（Override）：允许覆盖已有缓存（`ND6_FLAG_OVERRIDE` 0x20）。

**RS（Router Solicitation, type 133）**——`struct rs_header`：主机开机时向 all-routers 多播组发送，催促路由器发送 RA。

**RA（Router Advertisement, type 134）**——`struct ra_header`：

```
| type=134 | code=0 | chksum |
| Cur Hop Limit | flags | Router Lifetime |
|        Reachable Time       |
|         Retrans Timer       |
| options...
```

路由器周期性（或应 RS 之答）发送；lwIP 用其更新默认路由器表、可达时间、重传定时器，并解析 Prefix Information、MTU、RDNSS 等 option。

**RD（Redirect, type 137）**——`struct redirect_header`：`target_address`（更好的下一跳）+ `destination_address`，用于更正主机的目标缓存。

**DAD 语义**：地址处于 tentative 时，主机用源 `::` 向 solicited-node 多播组发 NS（不携带 Source LLADDR，见 lwIP `nd6_send_ns` 对 `ND6_SEND_FLAG_ANY_SRC` 的处理）。任何持有该地址的主机都应以 NA 应答（O=1, 发往 all-nodes 多播组），从而中止对方 DAD。

**Option 编码**（NDP 所有 option 统一为 TLV，长度单位为 8 字节）：

| type | 名称 | 关键字段 |
| --- | --- | --- |
| 1 | Source Link-Layer Address | 发送者 MAC |
| 2 | Target Link-Layer Address | 目标 MAC |
| 3 | Prefix Information | prefix_length/flags/Lifetimes/prefix |
| 5 | MTU | MTU |
| 25 | RDNSS（递归 DNS 服务器） | lifetime + IPv6 地址 |

## 核心机制

### 1. 请求/应答（address resolution）

**ARP 解析闭环**（lwIP）：

```
发 IP 数据报 → ip4_output
  → etharp_output(netif, q, ipaddr)         # 出口
      ├─ 广播/多播：直接映射 MAC（不查表）——ethbroadcast / 01-00-5E 多播 MAC
      └─ 单播：查 ARP 表
          ├─ 命中 STABLE：etharp_output_to_arp_index → ethernet_output（发送）
          └─ 未命中：etharp_query → 表项置 PENDING + etharp_request 广播
              └─ 报文入队（arp_table[i].q）

收 ARP REPLY → ethernet_input → etharp_input
  → etharp_update_arp_entry（表项 → STABLE，写 ethaddr，ctime=0）
      └─ 出队：ethernet_output 逐个发送排队报文（闭环闭合）
```

关键不变量：**REPLY 到达后，PENDING 队列中的所有报文必须恰好发出一次**（`etharp_update_arp_entry` 的 `while (arp_table[i].q != NULL)` 出队段）。

**NDP 解析闭环**（lwIP）：区别在于出口不再直接查表，而是先查**目标缓存**定下一跳，再查**邻居缓存**；未命中则创建 INCOMPLETE 邻居项并向 solicited-node 多播组发 NS；NA 到达后状态 → REACHABLE 并出队。

```
发 IPv6 数据报 → ip6_output → netif->output_ip6
  → ethip6_output(netif, q, ip6addr)         # 出口（Ethernet 网卡的 output_ip6）
      ├─ 多播：33:33:xx:xx:xx:xx 直接发送
      └─ 单播：nd6_get_next_hop_addr_or_queue
          └─ nd6_get_next_hop_entry：目标缓存 → 邻居缓存
              ├─ 命中 REACHABLE/DELAY/PROBE：返回 lladdr，立即发送
              ├─ 命中 STALE：→ DELAY，返回 lladdr，发送（延迟探测）
              └─ 未命中：新 INCOMPLETE 项 + multicast NS → nd6_queue_packet 入队

收 NA → ip6_input → icmp6_input → nd6_input（ICMP6_TYPE_NA 分支）
  → 校验（Hop Limit=255、code=0、target 非多播）
  → nd6_find_neighbor_cache_entry
  → 状态 → REACHABLE，reachable_time=reachable_time
      └─ 出队：nd6_send_q（闭环闭合）
```

### 2. 缓存老化与"到期前重请求"

- ARP：`etharp_tmr()`（每 1s）对所有非 EMPTY/STATIC 项 `ctime++`：
  - `ctime >= ARP_MAXAGE`（默认 300s）→ 过期回收；
  - PENDING 且 `ctime >= ARP_MAXPENDING`（5s）→ 过期回收；
  - 未到期 PENDING → 重发请求；
  - STABLE 到期前：`ARP_AGE_REREQUEST_USED_UNICAST`（=MAXAGE-30）起用单播请求、`..._BROADCAST`（=MAXAGE-15）起用广播请求刷新，并将状态置 `STABLE_REREQUESTING_1 → _2 → STABLE`（限速，2 秒内不再请求）。这是"常用连接不被解析空窗打断"的优化。
- NDP：`nd6_tmr()` 对邻居表按状态驱动（详见 `state-machine.md`）；路由器表/前缀表按 `invalidation_timer` 过期；目标缓存按 `age` 计数（用作回收的 LRU 指标，lwIP 不主动清除非满）。

### 3. Gratuitous ARP（主动缓存广播，RFC 5227 前身 RFC 3220 §4.6）

主机在地址变化（新 IP、网卡更换、DHCP 租约续订）时发送"自己请求自己"的 ARP REQUEST（`etharp_gratuitous(netif)` = `etharp_request(netif, 自身 IP)`）。作用：① 让链路上所有主机**更新/插入**对本机的映射，纠正陈旧条目；② 若收到应答，说明该 IP 已被占用（DHCP 探测流程使用）。lwIP 将其作为地址变更后的收敛手段。

### 4. 不可达检测（NUD / reachability probing）

NDP 的核心强化。REACHABLE 到期后不立即重解析，而是进入 STALE（信息仍可能正确）；只有**下次要使用**该邻居时才启动探测链：

```
STALE --(发包时)--> DELAY --(5s 内无上层可达性证据)--> PROBE
  --(发送单播 NS，最多 MAX_UNICAST_SOLICIT 次)--> 
     ├─ 收到 NA/NS 或上层证实（TCP ACK，nd6_reachability_hint）→ REACHABLE
     └─ 超限 → 删除项（若非路由器）
```

三种"可达性证据"：① 收到上层（TCP 证实数据交付）的提示；② 收到任何来自该邻居的有效 NS/NA；③ 收到单播探测的回执。lwIP 在 INCOMPLETE/PROBE 用 `probes_sent` 计数，达到 `LWIP_ND6_MAX_MULTICAST_SOLICIT`（=3）仍无应答即回收项（`nd6_free_neighbor_cache_entry`，但 `isrouter` 项不回收）。

### 5. 重复地址检测（DAD, RFC 4862）

SLAAC 生成的地址先进入 tentative 状态，用源 `::` 的 NS 探测（见 wire format 一节）。若收到针对该地址的 NA 或带 `::` 源的 NS，调用 `nd6_duplicate_addr_detected()`：地址状态置 `IP6_ADDR_DUPLICATED`，且若冲突的是链路本地地址（slot 0），由它派生的自动配置地址一并标记。lwIP 在 `nd6_tmr()` 中推进：tentative 计数递增（`IP6_ADDR_TENTATIVE_n`），达到 `LWIP_IPV6_DUP_DETECT_ATTEMPTS` 次无冲突后置 `IP6_ADDR_PREFERRED`，正式可用。

### 6. 路由器发现与前缀发现（RA/RS）

- 开机时发 RS（`nd6_send_rs`），路由器以 RA 应答；路由器也周期性单播 RA。
- 收到 RA：① 建立/刷新默认路由器项（`nd6_get_router`/`nd6_new_router`），写 `invalidation_timer = Router Lifetime`；② 可选更新 `reachable_time`/`retrans_timer`（`LWIP_ND6_ALLOW_RA_UPDATES`）；③ 解析 Prefix Information option：on-link 前缀进 `prefix_list`，带 Autonomous 标志的前缀触发 SLAAC（`nd6_process_autoconfig_prefix`，前缀/64 且 preferred ≤ valid 才接受）；④ MTU option 收紧 `mtu6`；⑤ RDNSS option 设置 DNS 服务器。
- 出口侧：`nd6_get_next_hop_entry` 先看目标是否在 on-link 前缀内或与静态地址同前缀（`nd6_is_prefix_in_netif`），是则下一跳=目的本身，否则 `nd6_select_router` 选择默认路由器（优先 REACHABLE，其次任何非 INCOMPLETE，最后轮转 INCOMPLETE 项）。

### 7. 重定向（Redirect, RD）

路由器收到发往"本链路其实可达"的目标的数据报时，可发 RD 把下一跳更正到更优邻居：lwIP 更新目标缓存 `next_hop_addr`，并视需要创建/更新该邻居的邻居缓存项（含 Target LLADDR option 时状态置 DELAY——"收到报文不代表反向可达"）。

### 8. 路径 MTU（与 IP 模块协作）

NDP 通过 ICMPv6 Packet Too Big（type 2）反馈更新目标缓存 PMTU（`nd6_get_destination_mtu` 供 IP 分片决策），并把 **最小 1280 字节**作为下限，避免 IPv4 式的 DF/分片黑洞问题。

## 设计取舍

- **ARP 的无状态 vs NDP 的有状态**：ARP 表只存"映射 + 存活时间"，没有主动探测，靠"用则刷新"；简单、省电、实现极小，但不可达检测滞后，易被缓存毒化。NDP 用六个状态换来主动探测与对失效的即时反应，代价是复杂度与定时器负担。
- **广播 vs 多播解析**：ARP 向全链广播，扰乱所有节点（每个节点都要检查 `dipaddr` 是否为自己）；NDP 用 solicited-node 多播组（`ff02::1:ffxx:xxxx`）把 NS 只发给"最可能持有该地址"的节点，降低 CPU 与窃听面。
- **固定数组 vs 动态结构**：lwIP 两个缓存都用固定数组（内存预先分配、无碎片、适合嵌入式），通过"回收启发式"（ARP：最老稳定→最老无队 pending→最老有队 pending；NDP：空→STALE→PROBE→DELAY→最老 REACHABLE→INCOMPLETE，且保护路由器）在满时选择牺牲项。Linux 用哈希表 + 动态 `neigh` 结构，容量大得多但内存管理复杂。
- **缓存一致性通过"每次接收都更新"维持**：收到任何来自 X 的 ARP/NS/NA 都刷新对 X 的映射（`etharp_update_arp_entry`、NDP 的 LLADDR 处理）。代价：若攻击者持续发伪造报文，可覆盖缓存（ARP 的著名弱点）；NDP 用 Override 位与 SEND 缓解。
- **协议与网卡解耦**：lwIP 通过 `netif` 抽象与函数指针（`netif->output_ip6` = `ethip6_output`）把"解析协议"与"具体网卡驱动"分离，使得 NDP 也可用于非 Ethernet（如 6LoWPAN）。
- **INCOMPLETE 不重试到死**：`probes_sent` 与固定表大小配合，保证解析失败最终回收，不无限占表。

## 不变量

1. **键唯一**：ARP 表内任意时刻同一 `(netif, ipaddr)` 至多一项；NDP 邻居缓存同一 `(netif, next_hop_address)` 至多一项。
2. **状态与队列一致**：仅 PENDING（ARP）/INCOMPLETE（NDP）表项可以非空队列；进入 STABLE/REACHABLE 时队列必须清空（出队发送）。
3. **REACHABLE 的 lladdr 必有效**：NDP 中只有拿到 LLADDR 才允许进入 REACHABLE（`nd6_reachability_hint` 对 INCOMPLETE/NO_ENTRY 直接返回，防滥用）。
4. **ctime 单调**：ARP 表 `ctime` 只增不减，仅在被使用/更新时清零，保证老化与"到期前重请求"的语义。
5. **路由器保护**：`isrouter` 邻居项不得被"满表回收"与 INCOMPLETE 超限删除。
6. **广播/多播不入表**：非单播地址绝不进入 ARP 表（`etharp_update_arp_entry` 对广播/多播/ANY 返回 `ERR_ARG`），避免无效缓存污染。
7. **过期必回收**：超过 `ARP_MAXAGE`/`ARP_MAXPENDING` 或 NDP 探测上限的表项最终回到 EMPTY/NO_ENTRY，使表不会永久被死条目占满。

## 边界条件与异常处理

### ARP

- **hwtype/hwlen/proto/protolen 不匹配**：`etharp_input` 首段检查，丢包 + `proterr`（防跨族误入）。
- **未配置接口**：`netif_ip4_addr` 为 0 时 `for_us=0`，收到请求不答（"we are unconfigured, ARP request ignored"）。
- **请求不是给我们的**：不答，但仍 `etharp_update_arp_entry(FIND_ONLY)` 刷新发送者映射（被动学习）。
- **非单播不缓存**：`etharp_update_arp_entry`/`etharp_query` 对广播/多播/ANY 返回 `ERR_ARG`。
- **表满**：`etharp_find_entry` 按"空位→最老 STABLE→最老无队 PENDING→最老有队 PENDING"回收；全无则 `ERR_MEM`，报文被丢弃（`q` 非空时 `memerr`）。
- **排队内存不足**：`ARP_QUEUEING` 下入队失败返回 `ERR_MEM`；`ARP_QUEUE_LEN`（默认 3）限制队列长度，超出丢最老包。
- **未知 opcode**：`etharp_input` 默认分支统计 `err` 后丢弃。

### NDP

- **Hop Limit != 255**：NDP 报文一律被丢弃（防跨子网注入），`nd6_input` 对 NS/NA/RA/RD 统一检查。
- **code != 0 / 长度不足**：`lenerr`/`proterr` 丢弃。
- **NS 目标非本机**：`accepted=0` 直接丢弃（无应答）。
- **DAD 冲突**：收到对 tentative 地址的 NA 或带 `::` 源的 NS → `nd6_duplicate_addr_detected` 置 DUPLICATED；自动配置派生地址一并失效（`nd6_duplicate_addr_detected` 内 slot 0 处理）。
- **DAD 通过**：`nd6_tmr` 中 tentative 计数到 `LWIP_IPV6_DUP_DETECT_ATTEMPTS` 次无冲突 → PREFERRED。
- **邻居表满**：`nd6_new_neighbor_cache_entry` 按启发式回收；路由器项不可回收，此时返回 -1，报文 `memerr` 丢弃。
- **路由器失效**：`nd6_select_router` 返回 -1 时出口 `ERR_RTE`，目标缓存项清空。
- **探测超限**：INCOMPLETE/PROBE 中 `probes_sent >= LWIP_ND6_MAX_MULTICAST_SOLICIT` 且非路由器 → 回收项，排队报文被丢弃（`nd6_free_neighbor_cache_entry` 释放队列）。
- **RA 生命周期**：`invalidation_timer` 递减到 0 → 清除路由器项，同时清理依赖该路由器的目标缓存项（`nd6_tmr` 路由器处理段），保证"路由器消失后不再使用死路由"。
- **on-link 前缀过期**：`prefix_list[i].invalidation_timer` 到 0 置 `netif=NULL`，之后该前缀不再视为 on-link。
- **PMTU 下限**：RA 的 MTU option 若小于 1280 忽略（`IP6_MIN_MTU_LENGTH` 检查），防链路 MTU 低于 IPv6 强制最小。
- **选项越界/未知**：RA option 解析越界 → `lenerr_drop_free_return` 丢弃；未知 option 类型仅统计 `proterr` 后跳过（不因不认识扩展而丢弃整个报文，容忍演进）。