# IPv4 / IPv6 · state-machine

## 状态

IPv4/IPv6 网络层**无显式、持久连接状态机**：它是无连接的逐跳转发协议，每个报文独立处理，不维护端到端会话状态。lwIP 中不存在类似 TCP 的连接表、ESTABLISHED 等状态。

仍然存在的「状态」有两类，均为**有限、局部、受超时约束**的协议状态，非连接状态机：

1. **IPv4 分片重组缓存**：对在途的同一标识（ID + 源/目的/Protocol）保持一个「已收集分片」的局部状态，直到收齐或超时。
2. **IPv6 分片重组缓存**：同上，按 (源地址, 目的地址, Identification) 归组。
3. **路由表 / 邻居缓存**：由路由模块与邻居层（ARP/NDP）维护，本模块只**读**不写（转发时查表）。

因此本文件按 §3 的要求记录**处理流程**，替代状态转移表。

## 状态

- 网络层整体：无状态（无连接，每包独立）。
- 每个入站分片：重组缓存条目 ∈ {收集中, 收齐待上抛, 超时丢弃}。
- 每个出站包：直接构造并发出，不保留发送状态（重传由上层 TCP 负责）。

## 事件

- `netif->input` / `ip_input` / `ip6_input`：链路层上抛一个包（可能是分片）。
- `ip_output` / `ip6_output` 被上层调用：请求发送一个包。
- ICMP/ICMPv6 报文到达：路由错误、目的不可达、TTL 过期、Packet Too Big 等（见异常分支）。
- 重组计时器到期：未收齐的分片被清理。
- 路由表 / 地址变化：查表结果即时生效，无状态联动。

## 状态转移

lwIP 中 IP 层没有状态转移，只有**函数调用流**。以下为 Nominal 缩略（详见 §处理流程）：

```
入站:
  ip_input (ip4_input) ──校验──▶ ──是否本机/可转发──▶ 协议分发 dispatch
  ip6_input               ──扩展头链遍历──▶            ip6_reass 重组 / 分发
出站:
  上层调用 ip_output ── 路由/MTU/分片(ip4_frag / ip6_frag) ──▶ netif->output
```

唯一的“状态转移”出现在分片重组缓存中：

- (收集) → 收到分片 → (收集，新增偏移区间) ；收齐 (MF=0 且连续) → (收齐) → 上抛后释放。
- (收集) → 超时 → 清空重组缓存，丢弃整个原始包。

## 正常 / 异常时序

**正常收包（IPv4，单包无分片）**
1. 链路层上抛原始包 → `ip4_input`；
2. 校验版本、IHL、Total Length、Header Checksum；
3. 选项拒绝检查：IHL>最小头且非 IGMP 的包，在 `IP_OPTIONS_ALLOWED==0` 时整体丢弃（`ip4.c:660-668`）；
4. 目的地址仲裁：本机 → 按 Protocol 分发（`icmp/udp/tcp/igmp`）；非本机且开启转发 → 查 `ip4_route` 转发；
5. 上抛伪头与载荷给上层，完成。

**正常发包（IPv4，单包）**
1. 上层调用 `ip4_output`（或带显式源地址与出接口的 `ip4_output_if_src`）；
2. 选路：查路由表得下一跳与出接口；
3. 长度 ≤ 出接口 MTU 且无 DF 约束 → 直接构造头，填 TTL、Protocol、校验和；
4. `netif->output` 交给链路层。

**IPv6 对应**
- 入：`ip6_input` 沿 Next Header 遍历；遇分片扩展头 → 内联调用 `ip6_reass` 重组（收齐前不继续分发）；最终分发到 icmp6/udp/tcp。
- 出：`ip6_output` / `ip6_output_if`；`ip6_frag` 在源端分片；IPv6 无 DF，超 MTU 由中继回报。

**异常分支**
- 入站：[版本错、长度错、校验错（IPv4）] → 丢弃、不回 ICMP；
- 入站分片：[超时未收齐] → 丢弃并清缓存；
- 入站 IPv6：[未知扩展头] → 丢弃（不回 ICMP）；
- 出站：[TTL/Hop Limit 已 0] → 丢弃拒绝发送；
- 出站：[超 MTU 且 DF=1（IPv4）] → 丢弃，回 ICMP Fragmentation Needed；
- 出站：[无源地址 / 无路由] → 返回错误（`ERR_` 系列），不发。

## 处理流程（无显式状态机时）

按 §4.3 的定义，把收包与发包各自的主路径刻度列举如下（详见 src/README.md 的调用链）：

**收包主路径**
```
netif：L2 上抛 (netif->input)
→ ip4_input        (src/core/ipv4/ip4.c)：版本/IHL/长度/校验/选项拒绝检查/分片重组
   → 本机? → dispatch ↑ (按 Protocol)
   → 否则 → route 转发
      → ip4_forward → netif->output
   （IPv6 对应 ip6_input：Next Header 链 + 分片扩展头内联重组（ip6_reass）→ dispatch）

**发包主路径**
上层调用 (ip4_output / ip6_output)
→ 选路 (ip4_route / ip4_route_src)
→ ip4_output_if / ip4_output_if_src (ip6_output_if_src)
     长度 > MTU?
       └ IPv4 & !DF → ip4_frag
       └ IPv6 → ip6_frag (源端分片)
→ netif->output

（分片接收路径：入站分片 → 重组缓存 → 收齐后进入 dispatch）
```

> 备注：本模块不引入 TCP/ICMP 的连接状态。若实践中发现邻居层（ARP/NDP）或路由表被耦合，请在对应模块（ARP/NDP、路由）记录其状态机，不要把网络层误记为有状态。