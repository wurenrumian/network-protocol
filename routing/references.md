# 路由 / 转发 / NAT / Netfilter / Conntrack · references

## 规范 / 标准

| 协议 | RFC | 内容 | 注意 |
| --- | --- | --- | --- |
| OSPF | RFC 2328（1998，OSPF v2） | 报文类型、邻接状态机、SPF 计算、区域与洪泛 | 后续由 RFC 5340 更新 v2 处理，FRR 实现基于 v2 |
| BGP-4 | RFC 4271（2006） | 状态机（Idle→…→Established）、路径属性、UPDATE 报文 | 取代 RFC 1771；FRR 的 bgp_fsm 按此实现 |
| RIP | RFC 2453（1998，RIP v2） | 距离向量、30s 周期更新、180s 超时 | 注意：RIP 与 OSPF/BGP 同属于本模块的"动态路由"主线，但 FRR 主要实现 OSPF/BGP，RIP 以概念对照阅读 |
| （补充）BGP-4 | RFC 4271 前身 RFC 1771 已废弃 | — | 阅读时以 RFC 4271 为准 |
| （补充）最长前缀匹配 | 无独立 RFC，见各实现 | — | 数据面转发核心机制 |

## 论文

- Dijkstra 最短路（SPF 的数学基础）：*A Note on Two Problems in Connexion with Graphs*, Numerische Mathematik, 1959。
- （可选）BGP 稳定性的经典讨论：Griffin & Wilfong, *An Analysis of BGP Convergence Properties*（理解 BGP 收敛与路径属性更新的关系）。

## 上游仓库（固定版本 / commit）

- **FRRouting / frr**：`https://github.com/FRRouting/frr`，固定 tag **`frr-8.5.1`**。
  - 复制进本模块 `src/upstream/` 的文件（保持原始相对路径）：
    - `ospfd/ospf_packet.c` — OSPF 报文收发
    - `ospfd/ospf_flood.c` — LSA 泛洪
    - `ospfd/ospf_lsa.c` — LSA 存储与洪泛表
    - `bgpd/bgp_packet.c` — BGP 报文解析/构造
    - `bgpd/bgp_fsm.c` — BGP 状态机
    - `zebra/zebra_rib.c` — RIB（路由信息库）维护
  - 许可证：`COPYING`（GPL v2）复制在 `src/LICENSES/COPYING`。
  - commit：tag 对应 commit 以 `git ls-remote --tags` 输出为准（tag 名即可回溯）。
- **Linux 内核**（转发/NAT/conntrack 概念，仅记录路径，不复制源码）：
  - `net/netfilter/nf_conntrack_core.c` — conntrack 状态跟踪核心
  - `net/netfilter/nf_nat_core.c`、`nf_nat_*.c` — NAT 映射
  - `net/ipv4/ip_forward.c`（或 `net/ipv4/route.c` 相关转发表查找）— 三层转发
  - 完整路径以本地内核源码树或 kernel.org 为准。

## 其他实现

- **BIRD**：`https://github.com/bird-community/bird`，OSPF/BGP 轻量实现，与 FRR 比较状态机与定时器。
- **Quagga**：`https://github.com/Quagga-Project/quagga`，GNU Zebra 的分支，另一条实现路线。

## 阅读备注

- **版本对应**：FRR 的 OSPF 基于 RFC 2328（v2），BGP 基于 RFC 4271。阅读源码时以 RFC 段落核对字段与状态转移。
- **字段核对**：`ospf_packet.c` 中 OSPF 头（版本/类型/长度/区域 ID/校验）对应 RFC 2328 §A.3；`bgp_packet.c` 的 BGP 头（16bit 长度、1bit type）对应 RFC 4271 §4.1。
- **本模块的特殊性**：路由控制面（FRR）是复制源码的唯一来源；转发/NAT/conntrack 是内核数据面，**不复制内核源码**，只记录路径并在 `protocol.md` 中做概念对照。
- **许可证边界**：复制进 `src/upstream/` 的全部是 FRR 文件，受 `src/LICENSES/COPYING`（GPL v2）约束；学习注释不改变上游授权范围，不伪造成上游改动。
- **观察建议**（若做 `observations.md`）：用 `tcpdump`/Wireshark 抓 OSPF Hello、BGP OPEN/UPDATE、或 `conntrack -L` 查看 NEW/ESTABLISHED 状态，与本模块源码对照。