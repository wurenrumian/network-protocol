# IPv4 / IPv6 · protocol

## 问题定义

网络层要回答的问题，是链路层无法回答的：**如何在一张由异构链路（不同 MTU、不同寻址）组成的互联网上，让任意两个节点按地址互相找到对方，并把上层载荷送达。**

IPv4 与 IPv6 是同一问题的两次不同回答。它们共同承担：

- **全局寻址**：把链路层的 MAC（只在本链路有意义）抽象为跨网唯一的 IP 地址，并支持按前缀划分子网，使路由可聚合。
- **逐跳转发**：每个中间节点只做「查路由表 → 决定下一跳 → 交给链路层」，不维护端到端连接状态。
- **载荷上界与分片**：每条链路有 MTU，网络层负责在必要时把超长载荷切分，并在终点重组（IPv4 可中继分片，IPv6 只在源端分片）。
- **防环与生命周期**：用 TTL（IPv4）/ Hop Limit（IPv6）限制报文存活跳数，超限即丢弃并（通常）回报 ICMP。
- **上层分发**：用 Protocol（IPv4）/ Next Header（IPv6）字段把载荷交给正确的传输层或 ICMP 处理。

**明确不负责**：不保证可靠交付（交给 TCP）、不保证顺序（交给上层）、不维护端到端状态（无连接）、不解决「下一跳 MAC 是什么」（交给 ARP/NDP）、不提供流控与拥塞控制（交给传输层）。

## 抽象对象

- **IP 地址（ip4_addr / ip6_addr）**：节点的网络层标识。IPv4 为 32 位，带可变长度子网掩码（netmask）；IPv6 为 128 位，固定 64 位前缀 + 64 位接口标识。lwIP 用 `ip4_addr_t`（`u32_t`）与 `ip6_addr_t`（4×`u32_t`）表示，地址运算见 `ip4_addr.c` / `ip6_addr.c`。
- **IP 报文（struct ip_hdr / struct ip6_hdr）**：网络层数据单元，由头 + 载荷（上层报文或扩展头）组成。
- **扩展头（IPv6）**：IPv6 把可选功能从固定头中移出，形成 Next Header 链（逐跳、路由、分片、目的地、AH/ESP 等）。
- **路由表项 / 下一跳**：决定出接口与下一跳 IP 的查找结果，本模块只消费它，路由表本身在路由模块（FRRouting）处理。
- **分片 / 重组单元（fragment）**：IPv4 用 ID + 偏移 + 标志（DF/MF）标识；IPv6 用分片扩展头（Fragment Header）标识，且只在源端产生。
- **netif（网络接口）**：lwIP 对网卡的抽象，承载 MTU、`output`/`output_ip6`（IP 层出口）与链路层上抛入口（`netif->input`）；驱动内部的 `linkoutput` 是 `output` 的底层实现。

## wire format

### IPv4 头（RFC 791，`struct ip_hdr` in `prot/ip4.h`）

固定 20 字节（无选项时），大端：

| 字段 | 位宽 | 语义 |
| --- | --- | --- |
| Version | 4 | 恒为 4 |
| IHL | 4 | 头长度（单位 4 字节），最小 5 |
| ToS / DSCP+ECN | 8 | 服务类型/差分服务 |
| Total Length | 16 | 整包字节数（头 + 载荷），上限 65535 |
| Identification | 16 | 分片标识，同一原始包的所有分片相同 |
| Flags | 3 | DF（禁止分片）、MF（还有后续分片） |
| Fragment Offset | 13 | 本片相对原载荷的偏移（单位 8 字节） |
| TTL | 8 | 每跳减 1，为 0 丢弃 |
| Protocol | 8 | 上层协议号（ICMP=1, TCP=6, UDP=17, IGMP=2…） |
| Header Checksum | 16 | 仅对头做 1 的补码和，载荷不参与 |
| Source / Destination | 32+32 | 源、目的地址 |

### IPv6 头（RFC 8200，`struct ip6_hdr` in `prot/ip6.h`）

固定 40 字节，大端：

| 字段 | 位宽 | 语义 |
| --- | --- | --- |
| Version | 4 | 恒为 6 |
| Traffic Class | 8 | 对应 IPv4 ToS |
| Flow Label | 20 | 流标识，用于同一流的分组 |
| Payload Length | 16 | **仅载荷**长度（不含 40 字节固定头，含扩展头） |
| Next Header | 8 | 下一头类型：扩展头或上层协议 |
| Hop Limit | 8 | 对应 IPv4 TTL，每跳减 1 |
| Source / Destination | 128+128 | 源、目的地址 |

### IPv6 扩展头（Next Header 链）

固定头之后可串联多个扩展头，每个扩展头用 `Next Header` 指向下一个。本模块关注的分片扩展头（`struct ip6_frag_hdr`）：

| 字段 | 位宽 | 语义 |
| --- | --- | --- |
| Next Header | 8 | 指向被分片载荷的上层/下一头 |
| Reserved | 8 | 保留 |
| Fragment Offset | 13 | 偏移（单位 8 字节） |
| Res | 2 | 保留 |
| M flag | 1 | 还有后续分片 |
| Identification | 32 | 分片标识 |

IPv6 的扩展头链是**顺序遍历**的：`ip6_input` 沿 Next Header 逐个解析，直到遇到已知的上层协议号或无法识别（此时丢弃）。lwIP 只实现分片扩展头，其余（路由头、逐跳选项等）不处理，遇到即丢弃——这是「Reading over extension headers」的简化选型。

### 分片（IPv4）

分片只切**载荷**，头在每个分片中复制并调整（Total Length、Fragment Offset、MF、Header Checksum 重算）。重组时按 ID + 源地址 + 目的地址 + Protocol 归组，按偏移拼接，全部收齐（MF=0 且偏移连续）才上抛。IPv4 允许中继节点继续分片，因此一个分片本身可再被分片。

## 核心机制

### 寻址

- IPv4 用 `ip4_addr`（32 位）+ 可变 netmask 划分子网，`ip4_addr_netcmp` 判断是否同网；`ip4_addr_mask` 做掩码运算。
- IPv6 用 `ip6_addr`（128 位），前缀固定 64 位，`ip6_addr_netcmp` 比较前缀（该比较是 `lwip/ip6_addr.h` 中的宏/内联）；地址解析与文本表示（`ip6addr_aton`/`ip6addr_ntoa`）见 `ip6_addr.c`。
- 本模块只负责「地址如何表示、比较、掩码」，不负责「如何学习地址」（邻居层 ARP/NDP、DHCP）。

### 转发

- 收包：`ip_input` 先做头校验（IPv4 checksum）、长度与版本检查，对 IHL>最小头的包做选项拒绝检查（`IP_OPTIONS_ALLOWED==0` 时整体丢弃，`ip4.c:660-668`），必要时分片重组，然后判断「目的地址是否本机 / 广播 / 组播」，是则按 Protocol 分发，否则若开启转发则查 `ip4_route` 转出。
- 发包：`ip_output` 依据目的地址查路由表得下一跳与出接口，处理 DF/分片，最后调用 `netif->output` 交给链路层。

### 分片 / PMTU

- IPv4：`ip4_output` 若载荷超过出接口 MTU，且未设 DF，则 `ip4_frag` 切分；若设 DF 则直接丢弃并触发 ICMP（Fragmentation Needed），由上层做 PMTU 探测（RFC 8201）。
- IPv6：**只在源端分片**（`ip6_frag`），中继节点对超过 MTU 的包直接丢弃并回 ICMPv6 Packet Too Big，源端据此缩小 PMTU。IPv6 无广播，故无 DF 概念。
- PMTU 发现（RFC 8201）：通过 ICMP 的「报文过大」反馈，动态调整发送尺寸，避免中继分片。

### TTL / Hop Limit

- IPv4 `ttl`、IPv6 `hop_limit` 每跳减 1；减到 0 时丢弃并（通常）回 ICMP Time Exceeded，防止路由环导致报文无限循环。
- 出接口发送时若 TTL/Hop Limit 为 0（或未设默认值），lwIP 会拒绝发送或补默认值。

### 校验

- IPv4 头校验：对头做 1 的补码和，接收端校验失败即丢弃（`ip4_input` 中 `ip4_chksum` 检查）。载荷校验由上层（TCP/UDP/ICMP）负责。
- IPv6 **无头校验和**（固定头与扩展头不校验），依赖链路层（如以太网 CRC）与上层（TCP/UDP/ICMPv6 的伪头校验）保证完整性。这是 IPv6 的明确设计取舍：减少逐跳计算、简化转发。

### 协议分发

- IPv4：`ip4_input` 依 `Protocol` 字段调用 `icmp_input`、`udp_input`、`tcp_input`、`igmp_input` 等。
- IPv6：`ip6_input` 依 Next Header 链调用 `icmp6_input`、`udp_input`、`tcp_input` 等，遇分片扩展头内联调用 `ip6_reass` 重组；未识别即丢弃。

## 设计取舍

- **IPv4 可变头（选项）→ IPv6 扩展头链**：IPv4 把选项塞进固定头导致头长不定、每跳都要解析；IPv6 把可选功能移出固定头，固定 40 字节，转发更简单，但引入 Next Header 链的遍历开销与「未知扩展头丢弃」的安全取舍。
- **IPv4 中继分片 → IPv6 源端分片**：中继分片让中间节点承担重组/再分片负担，且一个分片丢失导致整包重组失败；IPv6 改为源端分片 + 中继丢包回报，把负担推到端到端，配合 PMTU 更高效。
- **IPv4 头校验 → IPv6 无头校验**：IPv4 每跳重算头校验；IPv6 依赖链路层 + 上层伪头校验，减少逐跳 CPU，代价是链路层若不可靠则需上层兜底。
- **IPv4 广播 → IPv6 组播为主**：IPv6 取消广播，用组播（FF02::1 等）实现邻居发现，减少对无关主机的打扰。
- **IPv4 可变子网 → IPv6 固定前缀**：IPv4 子网掩码可变，路由表项需同时存掩码；IPv6 前缀固定，简化最长前缀匹配与地址聚合。
- **lwIP 实现取舍**：lwIP 面向嵌入式，只实现分片扩展头，其余扩展头直接丢弃（不逐项处理），换取小内存与简单转发；分片扩展头在 `ip6_input` 内同步内联处理，非零偏移/置 M 位的包直接调用 `ip6_reass`（`ip6_frag.c`）做重组，重组收齐前不继续分发。

## 不变量

- **头字段约束**：IPv4 `Version==4`、`IHL>=5`、`Total Length>=IHL*4` 且与接收长度一致；IPv6 `Version==6`、`Payload Length` 与载荷一致。
- **长度守恒**：载荷长度 = 总长 − 头长（IPv4）；载荷长度 = Payload Length（IPv6）。分片重组后长度等于原载荷。
- **TTL/Hop Limit 单调递减**：每跳至少减 1，到 0 必丢弃，保证无环。
- **校验一致性**：IPv4 头校验在接收端必须通过；IPv6 依赖上层伪头校验（TCP/UDP/ICMPv6）。
- **分片归组一致性**：同一组分片共享 ID（+源/目的/Protocol），偏移不重叠、不越界、按序拼接。
- **地址不变量**：源地址在发送前必须可用（lwIP 要求 `ip4_output_if_src` 提供有效源地址）；目的地址决定路由与出接口。

## 边界条件与异常处理

- **校验失败 / 版本不符 / 长度越界**：直接丢弃，不回报（避免放大攻击）。`ip4_input` 对 `ip4_chksum` 失败、`ip6_input` 对版本/长度不符均静默丢弃。
- **TTL/Hop Limit 归零**：丢弃并回 ICMP Time Exceeded（若允许回报）。
- **载荷超 MTU 且 DF 置位（IPv4）**：丢弃并回 ICMP Fragmentation Needed，触发 PMTU 探测。
- **IPv6 载荷超 MTU**：中继丢弃并回 ICMPv6 Packet Too Big，源端缩小 PMTU；源端 `ip6_frag` 负责切分。
- **分片丢失 / 重组超时**：重组缓存超时未收齐则丢弃整组（lwIP 有重组超时机制）。
- **未知 / 未支持扩展头（IPv6）**：丢弃，不回 ICMP（lwIP 简化选型）。
- **目的地址非本机且未开启转发**：丢弃（不转发）。
- **源地址不可用 / 未配置**：发送失败，返回错误（`ip4_output_if_src` 的地址校验）。
- **空载荷 / 最小合法包**：IPv4 头 20 字节、IPv6 头 40 字节是最小合法尺寸，小于此即非法丢弃。
- **广播 / 组播地址处理**：IPv4 广播（有限/定向）与组播需特殊分发路径；IPv6 用组播实现邻居发现，需区分链路本地与全局地址。