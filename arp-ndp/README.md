# ARP / IPv6 NDP

## 定位

本模块覆盖链路层地址解析的两种主流协议：

- **ARP（Address Resolution Protocol, RFC 826）**：IPv4 数据报在 Ethernet 上传输前，把目的 IP 地址解析为 48-bit MAC 地址。
- **IPv6 NDP（Neighbor Discovery Protocol, RFC 4861）**：IPv6 邻居发现，除地址解析外还承担路由器发现、前缀发现、不可达检测（NUD）与重复地址检测（DAD）等职责。

核心问题是同一个：**网络层地址（IP）与链路层地址（MAC）之间的映射如何建立、缓存、老化与撤销**。ARP 是"只解决一个问题"的极简协议（请求/应答两报文 + 一个缓存表）；NDP 在同一层上重构了 ARP 的教训，把地址解析、路由发现、重定向、DAD 与不可达检测合并进 ICMPv6 报文族，并引入显式邻居状态机。

在阅读主干中的位置：紧随 Ethernet 模块之后，是 IP 层向链路层发送报文必经的出口（IP 模块的 `ip4_output`/`ip6_output` 之下、`ethernet_output` 之上），也是理解"报文在网卡上到底发给谁"的第一站。

本模块的职责边界：**不负责** IPv6 全局路由选择（属于 ipv4-ipv6/路由模块）、DHCP（dhcp 模块）、链路层多播组管理（IPv6 MLD）与 IPv4 IGMP。

## 前置模块

- **Ethernet / 802.3**：Ethernet II 帧、MAC 地址、`0x0806`/`0x86dd` EtherType、广播/多播地址判定。ARP 报文直接承载在 Ethernet 帧中，IPv6 邻居报文承载在 ICMPv6 中、再承载在 IPv6 over Ethernet 中。
- **协议抽象与编码**：字节序、报文布局、校验与超时/重传的通用分析语言。
- 建议同步准备（不必先读完）：**IPv4 / IPv6**（本模块只依赖"IP 地址的语义：单播/多播/广播判定、链路本地范围"）、**ICMP**（NDP 报文类型定义于 ICMPv6 中）。

## 推荐阅读顺序

1. 读本目录 `protocol.md`，建立"IP→MAC 解析"的问题模型与 ARP/NDP 的差异图景。
2. 读 `state-machine.md`，先掌握 IPv6 NDP 的显式邻居状态机（INCOMPLETE→REACHABLE→STALE→DELAY→PROBE），再对照 ARP 表项的四段生命周期（EMPTY→PENDING→STABLE→…→EMPTY）。
3. 沿 `src/README.md` 的调用链读源码：先读 core/ 的 `etharp.c` 与 `nd6.c` 两条闭环；再沿"报文入口"补 integration/ 的 `ethernet.c`（以太网分发）与 `icmp6.c`（ICMPv6 分发）；platform/ 只需看 netif 抽象与 `output_ip6` 的函数指针如何被 `ethip6_output` 挂接。
4. 对照 `references.md` 中的 Linux 内核 `neigh` 实现，比较 NDP 状态机与 Linux `arp_*`/`neigh_*` 结构、以及 NAT/ARP 的取舍差异。
5. 可选：用 tcpdump/Wireshark 观察一次 `ping` 前后的 ARP 或 NS/NA 交换，把抓包与源码闭环对应（写进 `observations.md`）。

## 源码入口

主实现 **lwIP 2.1.3**（git 树 `STABLE-2_1_3_RELEASE` = commit `6ca936f6b588cee702c638eee75c2436e6cf75de`）。

| 入口 | 文件 | 说明 |
| --- | --- | --- |
| `etharp_input()` | `src/core/ipv4/etharp.c` | ARP 收包：表更新 → 应答/忽略 |
| `etharp_output()` | `src/core/ipv4/etharp.c` | ARP 发包：查表 → 缓存命中/入队解析 |
| `etharp_tmr()` | `src/core/ipv4/etharp.c` | 1s 定时：老化、PENDING 重发、REREQUESTING |
| `nd6_input()` | `src/core/ipv6/nd6.c` | NDP 收包：NS/NA/RS/RA/RD/PTB 分发与状态推进 |
| `nd6_get_next_hop_addr_or_queue()` | `src/core/ipv6/nd6.c` | 出口：解析下一跳 MAC 或入队 |
| `nd6_tmr()` | `src/core/ipv6/nd6.c` | 定时：邻居状态老化、DAD、RS 重发、路由器/前缀/目标缓存过期 |

完整调用链、函数清单与阅读范围见 `src/README.md`。

## 主实现 / 对照实现

- **主实现：lwIP**（`github.com/lwIP-tcpip/lwip`，tag `STABLE-2_1_3_RELEASE`）。选择理由：完整用户态协议栈、单文件可独立追踪闭环、同时含 ARP 与 NDP，且 netif 抽象清晰分离协议与网卡。
- **对照实现：Linux 内核**（`net/ipv4/arp.c` 与 `net/ipv6/ndisc.c`，不复制进 `src/`，仅在 `references.md` 记录路径）。对比点：Linux 的 `neigh` 表项结构与 lwIP 的固定数组表、NDP 状态的 `neigh` 实现、以及内核如何用 seq/ 定时器做 NUD。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。