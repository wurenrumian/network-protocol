# 路由 / 转发 / NAT / Netfilter / Conntrack

## 定位

本模块覆盖网络层与传输层的"数据面"与"控制面"：

- **路由控制面（主实现 FRRouting）**：RIP、OSPF、BGP 三类动态路由协议，回答"通往目的网络的下一条怎么选"，产出 RIB（Routing Information Base）并通过 zebra 下发到转发表。
- **转发数据面 / NAT / Netfilter / Conntrack（Linux 内核）**：收到分组后按最长前缀匹配查找转发表、按 conntrack 记录的状态做有状态转发、NAT 地址映射。本模块以内核概念 + 源码路径对照为主，不复制内核源码。

控制面决定"表里写什么"，数据面决定"表怎么被查"。本模块的核心闭环是：**路由协议报文 → RIB 更新 → 转发表下发 → 最长前缀匹配转发**；NAT/conntrack 是同一数据面上叠加的状态跟踪与地址改写。

## 前置模块

- **协议抽象与报文编码**（§4.1）：TLV、字节序、长度边界、校验，OSPF/BGP 报文分析沿用同一套语言。
- **Ethernet / ARP / IPv4 / IPv6 / ICMP**（§4.2/§4.3，lwIP）：RIP/OSPF 报文封装在 IP 之上，BGP 走 TCP；转发表条目的前缀结构直接建在 IP 地址上。
- （可选）**VLAN / bridge**：理解三层转发之前先建立二层转发/MAC 学习的对照。

## 推荐阅读顺序

两条阅读线，先控制面、后数据面，最后合流。

1. **协议与规范**：先读 `protocol.md` 的问题定义与 wire format，再对照 RFC（见 `references.md`）。
2. **路由控制面（FRR）**：`src/README.md` 的阅读顺序——先 zebra_rib（RIB 是终点），再 ospf_packet/flood/lsa（邻居状态机与泛洪），再 bgp_fsm/bgp_packet（TCP 之上的状态机）。
3. **转发 / NAT / conntrack（内核概念）**：`protocol.md` 的"核心机制"一节，按给出的内核路径在本地源码树或 kernel.org 上对照阅读，不要求下载。
4. **合流闭环**：把"RIB 更新 → 转发表"与"最长前缀匹配 → 出口接口"串成一条从控制面到数据面的完整路径。

## 源码入口

- `src/README.md`：上游版本、文件清单（core/integration/platform 分类）、阅读顺序与调用链、入口/结束函数。
- 控制面主入口：`zebra/zebra_rib.c`（RIB 结构与维护）、`ospfd/ospf_packet.c`（OSPF 收发）、`bgpd/bgp_fsm.c`（BGP 状态机）。
- 数据面概念入口（内核，记录路径即可）：`net/netfilter/nf_conntrack_core.c`、`net/netfilter/nf_nat_*.c`、路由查表逻辑所在的转发路径（见 `protocol.md`）。

## 主实现 / 对照实现

| 角色 | 实现 | 用途 |
| --- | --- | --- |
| 主实现 | **FRRouting（FRR）**，固定 tag `frr-8.5.1` | RIP/OSPF/BGP 控制面源码阅读 |
| 对照 | **BIRD** | 与 FRR 比较 OSPF/BGP 状态机与定时器取舍 |
| 对照 | **Quagga** | GNU Zebra 的分支，另一条轻量路由实现路线 |
| 概念补充 | **Linux 内核 netfilter/ip_forward** | 转发/NAT/conntrack 只作概念对照，不复制源码 |

## 目录规范

参见根目录 `protocol-learning-design.md` §3。模块目录下：`protocol.md`（协议设计）、`state-machine.md`（状态机）、`references.md`（版本与来源）、`src/`（上游源码与导航页）。