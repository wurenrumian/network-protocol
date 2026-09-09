# ARP / IPv6 NDP · state-machine

> 本文件记录两套状态逻辑：(A) IPv6 NDP 邻居缓存的**显式状态机**（RFC 4861 §7.3，lwIP 在 `nd6.c` 中逐状态实现）；(B) IPv4 ARP 表项的**生命周期**（lwIP `etharp.c` 的 `enum etharp_state`）。ARP 没有 NDP 那样的主动探测状态机，故用生命周期 + 定时器流程描述。

## A. IPv6 NDP 邻居状态机

### 状态

lwIP 定义于 `src/include/lwip/priv/nd6_priv.h`：

```c
enum nd6_neighbor_cache_entry_state {
  ND6_NO_ENTRY = 0,   /* 空槽（未使用） */
  ND6_INCOMPLETE,     /* 已发 NS，等待 NA */
  ND6_REACHABLE,      /* 已知可达，定时器倒计时 */
  ND6_STALE,          /* 超时未证实，信息可能仍正确 */
  ND6_DELAY,          /* STALE 后首次使用时，等待上层证据 */
  ND6_PROBE           /* 已发单播探测，等待应答 */
};
```

每项还携带 `isrouter`（路由器保护）与 `counter` 联合体（`reachable_time`/`delay_time`/`probes_sent`/`stale_time`）。

### 事件

| 事件 | 触发源 | lwIP 位置 |
| --- | --- | --- |
| **解析发起**（要发往未知邻居） | 出口 `nd6_get_next_hop_addr_or_queue` → `nd6_get_next_hop_entry` | `nd6.c:2043` 附近 |
| **收到应答**（NA） | `nd6_input` ICMP6_TYPE_NA 分支 | `nd6.c:416` |
| **收到 NS（含/不含 LLADDR）** | `nd6_input` ICMP6_TYPE_NS 分支 | `nd6.c:518-545` |
| **收到 RA（带 Source LLADDR）** | `nd6_input` ICMP6_TYPE_RA 分支 | `nd6.c:679-684` |
| **重定向（RD，带 Target LLADDR）** | `nd6_input` ICMP6_TYPE_RD 分支 | `nd6.c:878-888` |
| **REACHABLE 超时** | `nd6_tmr` | `nd6.c:983-989` |
| **DELAY 超时** | `nd6_tmr` | `nd6.c:994-1001` |
| **探测超限** | `nd6_tmr` INCOMPLETE/PROBE | `nd6.c:967-1013` |
| **使用该邻居（出口 STALE 项）** | `nd6_get_next_hop_addr_or_queue` | `nd6.c:2271-2275` |
| **上层可达性提示**（TCP ACK） | `nd6_reachability_hint` | `nd6.c:2330` |

### 状态转移

```text
                发 NS (多播)                    NA 应答 / 收到 NS+LLADDR
(NO_ENTRY) ───────────────────> INCOMPLETE ─────────────────────────────> REACHABLE
                                    │                                    │
      probes_sent >= MAX_MULTICAST_SOLICIT（且非路由器）                   │
                                    ▼                                    │
                              (回收 → NO_ENTRY)                        reachable_time 超时
                                                                        ▼
                                    RA 带 Source LLADDR（路由器）        STALE
                                    且 state==INCOMPLETE ───────────────>│
                                                                         │
      出口发现 STALE 邻居（要发包）：                                    │  STALE 计时（累计，无操作）
      STALE ──────────────────────────> DELAY                          │
                                        │                              │
         5s 内收到上层证据 / NS / NA ────┼──> REACHABLE                 │
                                        │                              │
                     delay_time 超时    │                              │
                                        ▼                              │
                                     PROBE                             │
                                        │                              │
                   单播 NS，probes_sent++│                              │
                                        │ 应答 → REACHABLE             │
                 超限且非路由器 ────────> (回收 → NO_ENTRY)             │
                                                                        │
               （REACHABLE 也可由 nd6_reachability_hint 从任意
                 非 INCOMPLETE/NO_ENTRY 状态直接置入）
```

要点：

- **INCOMPLETE → REACHABLE**：收到 NA（`nd6_input:416`）或收到携带 LLADDR 的 RA（路由器项，`nd6.c:682`）。若收到 NS（解析我们时），`nd6.c:518-545` 只把 INCOMPLETE 置为 **DELAY** 而非 REACHABLE——"收到 NS 只证明对方可达，不证明反向可达"，用 DELAY 拖延探测，等上层证据。
- **REACHABLE → STALE**：`nd6_tmr` 中 `reachable_time` 倒计时归零。此时**不丢缓存**，仅标记可疑。
- **STALE → DELAY**：出口发现 STALE 项（`nd6.c:2271`）。设 `delay_time = DELAY_FIRST_PROBE_TIME/ND6_TMR_INTERVAL`（5s/1s=5 tick）。**仍立即发送**该包（状态才 DELAY，出口对 REACHABLE/DELAY/PROBE 都返回 lladdr），探测是后台的。
- **DELAY → PROBE**：`delay_time` 归零（`nd6.c:996`），重置 `probes_sent=0`，开始单播 NS。
- **PROBE 应答** → REACHABLE；**PROBE 超限**（`probes_sent >= MAX_MULTICAST_SOLICIT` 且非路由器）→ `nd6_free_neighbor_cache_entry` 回收。
- **删除保护**：`nd6_free_neighbor_cache_entry` 对 `isrouter` 项直接返回（`nd6.c:1546`），路由器不被回收/超限删除；其删除只能走"路由器失效"路径（RA 过期，`nd6_tmr` 路由器处理段）。

### 正常 / 异常时序

正常解析（A 请求 B）：

```
A                                                      B
│ 出口: 目标缓存未命中 → 邻居表新建 INCOMPLETE            │
│ nd6_get_next_hop_entry                                │
│    probes_sent=1, 多播 NS(目标=B 的 solicited-node) ───▶  B: accepted=1
│  排队报文 nd6_queue_packet(q)                          │
│                                                      │  B: 更新/新建 A 邻居项(DELAY)，
│                                                      │     单播 NA(S=1,O=1,+Target LLADDR)
│  ◀──── 单播 NA ────────────────────────────────────────│
│ nd6_input NA 分支: state=REACHABLE,                   │
│   reachable_time=reachable_time                       │
│ nd6_send_q: 出队发出排队报文（闭环闭合）                │
│                                                        │
│ 30s 后 REACHABLE 超时 → STALE                         │
│ A 再发包 → STALE→DELAY → 5s 无证据 → PROBE(单播 NS)     │
│ ◀──── NA ── REACHABLE（重新证实）                      │
```

异常时序（B 消失）：

```
A                                                    
│ INCOMPLETE, probes_sent=1,2,3 (每 RETRANS_TIMER=1s)
│ probes_sent >= 3 且非路由器
│ nd6_free_neighbor_cache_entry(i)   ← 回收，排队报文丢弃
│ 下次再发包重新走 INCOMPLETE
```

异常时序（DAD 冲突，C 已占用目标地址）：

```
A 配置新地址(自动配置) → state=TENTATIVE, nd6_send_ns(src=::, 多播)
  路由器/持有者 C ◀──── 收到 NS(src=::, target=该地址)
C: 检查 target 是否为本机地址 → 是 → 单播 NA(O=1, 发往 all-nodes)
A ◀──── 收到 NA → nd6_duplicate_addr_detected → IP6_ADDR_DUPLICATED
       （若冲突的是链路本地地址 slot0，则派生地址一并 DUPLICATED）
```

异常时序（路由器失效）：

```
RA 周期刷新 default_router_list[i].invalidation_timer
   …… 若不再收到 RA，timer 归零：
nd6_tmr 路由器段：清空依赖该路由器的目标缓存项，
   置 neighbor_entry->isrouter=0，router 项清空
   → 之后 nd6_select_router 不再选它；出口 ERR_RTE 或改走其他路由器
```

## B. ARP 表项生命周期（IPv4）

### 状态

lwIP `src/core/ipv4/etharp.c`：

```c
enum etharp_state {
  ETHARP_STATE_EMPTY = 0,        /* 空槽 */
  ETHARP_STATE_PENDING,          /* 已发请求，等待 REPLY */
  ETHARP_STATE_STABLE,           /* 有效映射 */
  ETHARP_STATE_STABLE_REREQUESTING_1,  /* 到期前已重请求（单播） */
  ETHARP_STATE_STABLE_REREQUESTING_2,  /* 1s 后限速缓冲 */
#if ETHARP_SUPPORT_STATIC_ENTRIES
  , ETHARP_STATE_STATIC           /* 静态项，永不过期 */
#endif
};
```

### 生命周期

```text
 EMPTY
  │  出口未命中 + etharp_query
  ▼
 PENDING ── 收到 REPLY ────────────────────────────────▶ STABLE
  │  （etharp_update_arp_entry: 写 ethaddr, ctime=0,
  │    出队发送所有排队报文）
  │
  │  etharp_tmr: ctime>=ARP_MAXPENDING(5s) 或请求重发超限
  │  etharp_tmr: 重发 ARP 请求（ctime<ARP_MAXPENDING 时）
  ▼
(回收 → EMPTY)

 STABLE
  │  etharp_tmr: ctime++；
  │  ctime 到达 MAXAGE-30：etharp_output_to_arp_index
  │    发单播重请求 → STABLE_REREQUESTING_1（限速：2s 内不再请求）
  │  etharp_tmr: _1 → _2 → 下一 tick → 回 STABLE
  │  ctime >= ARP_MAXAGE(300s)：
  ▼
(etharp_free_entry → EMPTY，释放排队 pbuf/队列槽)
```

- **PENDING 期间**：`etharp_tmr` 每秒重发请求（`etharp_request`）；超过 `ARP_MAXPENDING` 直接回收。
- **STABLE 到期前**：`ARP_AGE_REREQUEST_USED_UNICAST`(=270s) 起单播重请求，`..._BROADCAST`(=285s) 起广播重请求，状态经 `STABLE_REREQUESTING_1/2` 限速（每次仅一个请求、间隔 ≥2s），成功后回 STABLE 且 `ctime` 清零（`etharp_output_to_arp_index` 内判断）。若无应答仍会在 300s 到期回收——之后下个包重新走 PENDING 解析。
- **静态项**（`ETHARP_SUPPORT_STATIC_ENTRIES`）：`etharp_tmr` 跳过，`etharp_find_entry` 回收时跳过，永不失效。

### 正常 / 异常时序

正常解析：

```
A 发 IP 包 → etharp_output 未命中 → etharp_query:
   EMPTY→PENDING, etharp_request 广播
   （同时把 IP 包 pbuf_ref/clone 入队 arp_table[i].q）
B ◀──── ARP REQUEST(dipaddr=B)
B: etharp_input: for_us=1 → 更新对 A 的映射(TRY_HARD),
   回复 ARP REPLY(单播)
A ◀──── ARP REPLY(shwaddr=B, sipaddr=B)
A: etharp_input → etharp_update_arp_entry:
   PENDING→STABLE, ctime=0, 出队发送排队包（闭环闭合）
```

异常时序（B 不存在 / 离线）：

```
A: PENDING, etharp_tmr 每秒重发请求
   ctime 达 ARP_MAXPENDING(5s) → etharp_free_entry → EMPTY
   （排队 IP 包被释放/丢弃；上层按需重传，见 TCP 模块）
```

异常时序（B 更换网卡 → MAC 变化）：

```
A 缓存 STABLE(B_ip → 旧MAC)；B 更换后主动发 gratuitous ARP
   (etharp_gratuitous = etharp_request(自身IP))
A ◀──── ARP REQUEST(shwaddr=新MAC, sipaddr=B_ip, dipaddr=B_ip)
A: etharp_input → etharp_update_arp_entry:
   旧 STABLE 项被覆盖为 新MAC，ctime=0   ← 主动收敛
```

异常时序（IP 冲突，DHCP 场景）：

```
A 收到 DHCP 提供，先发 gratuitous ARP 探测
   若收到 REPLY / 看到冲突请求 → 该 IP 已被占用 → 重新请求 DHCP
   （lwIP: dhcp_arp_reply / autoip_arp_reply 钩入 etharp_input）
```

### 与 NDP 状态机的对照

| 概念 | ARP | NDP |
| --- | --- | --- |
| 解析等待 | PENDING | INCOMPLETE |
| 有效映射 | STABLE | REACHABLE |
| 可疑但保留 | —（到期直接回收，靠重请求续期） | STALE/DELAY/PROBE（三级渐进探测） |
| 主动失效检测 | 无（用则刷新 + 到期前重请求） | NUD 单播探测 |
| 防冲突 | 无（借 DHCP/autoIP） | DAD（tentative 地址） |
| 路由器保护 | — | isrouter 标志 + 独立的默认路由器表 |

ARP 的"到期前重请求"（REREQUESTING）在功能上接近 NDP 的 STALE→DELAY 出口探路：都试图在映射失效前无感续期；差别是 ARP 无"不可达确认"——超时即回收，不留 PROBE 级证据收集。

## 处理流程（无显式状态机时）

ARP 本身没有逐报文状态机，但其收包处理可归纳为固定流程（RFC 826 "Packet Reception"）：

1. 校验 hwtype/proto/hwlen/protolen（不符 → 丢弃）。
2. 复制并比对 `dipaddr` 与接口 IP，得 `for_us`。
3. 无条件 `etharp_update_arp_entry` 更新发送者映射（`for_us ? TRY_HARD : FIND_ONLY`）——**先学习，后分派**。
4. 按 opcode 分派：
   - REQUEST：`for_us` → 回 REPLY；否则静默（未配置接口也不答）。
   - REPLY：映射已在步骤 3 写入；交给 DHCP/autoIP 冲突检测钩子。
   - 其他：统计 `err`，丢弃。

NDP 的 `nd6_input` 是真正的 switch 状态机：`NA/NS/RA/RD/PTB` 五个分支分别驱动邻居缓存、默认路由器表、前缀表、目标缓存与 PMTU（详见 `protocol.md` 与 `src/README.md` 的调用链）。