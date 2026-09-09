# ICMP · references

## 规范 / 标准

- **RFC 792** — *Internet Control Message Protocol*（1981-09）。ICMPv4 基础定义：报文格式、type/code、校验和、差错报文中回带原始 IP 头 + 8 字节的约定、差错不回差错的规则。echo/timestamp/信息类类型的原始出处。
- **RFC 4443** — *Internet Control Message Protocol (ICMPv6) for the Internet Protocol Version 6 (IPv6) Specification*（2006-03）。ICMPv6 的定义：错误类（0–127）/信息类（128–255）类型空间、伪头部校验和（Next Header=58）、差错回带规则、对差错消息不再响应差错消息、PTB 与 PMTUD 的关系。注：该编号的现行 ICMPv6 规范编号已更新（见下）。
- **RFC 4884** — *Extended ICMP to Support Multi-Part Messages*（2007-04）。定义 ICMP 扩展机制（length 字段、多段消息），是差错报文可携带额外扩展（如 MPLS、TRILL 前缀）的规范基础。lwIP 2.1.3 未实现扩展 ICMP。
- 补充与修订：
  - **RFC 1812** §4.3（路由器 ICMP 要求：差错速率限制、组播差错处理）；
  - **RFC 1122** §3.2（主机 ICMP 要求）；
  - **RFC 1256** / **RFC 2461**（ICMP Redirect 用于 IPv4/IPv6 路由通知）；
  - **RFC 1191**（IPv4 PMTUD）、**RFC 1981**（IPv6 PMTUD 与 PTB）；
  - **RFC 6918**（ICMP 源节点抑制废弃说明）、**RFC 6633**（ICMP 差错限定——「Deprecation of ICMP Source Quench」相关背景）。
- **RFC 4443 编号勘误（阅读时务必注意）**：`icmp6.c` 文件头注释写「as per RFC 4443」。lwIP 注释中的 RFC 编号沿用旧编号，实际现行 ICMPv6 规范编号已更新，具体以 rfc-editor.org 为准。本仓库按上游原样保留注释，references 中记录此勘误（对应 `protocol-learning-design.md` §6 的勘误处理：不改上游，在文档记录）。

## 论文

- 无与 ICMP 直接对应的经典论文；相关背景阅读可参考：
  - V. Jacobson（1988）— *Congestion Avoidance and Control*（ICMP Source Quench 局限性与端到端拥塞控制的动机）；
  - IPv6 邻居发现的协议演化参见 RFC 4861（NDP）设计讨论。

## 上游仓库（固定版本 / commit）

- **lwIP**（主实现）：`github.com/lwIP-tcpip/lwip`
  - tag：`STABLE-2_1_3_RELEASE`
  - commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
  - 本模块复制文件（原始路径 → `icmp/src/upstream/` 保留相对路径）：
    - `src/core/ipv4/icmp.c`
    - `src/core/ipv6/icmp6.c`
    - `src/include/lwip/prot/icmp.h`
    - `src/include/lwip/prot/icmp6.h`
  - 许可证：`COPYING`（BSD-3-Clause 风格，见 `icmp/src/LICENSES/COPYING`）
- 固定版本依据：`protocol-learning-design.md` §4.0（lwIP 为 Ethernet/ARP/IP/ICMP/UDP/TCP 的主实现，`src/core/` 与 `src/include/` 中对应协议文件）。

## 其他实现

- **Linux 内核** `net/ipv4/icmp.c`、`net/ipv6/icmp.c`：对照实现（不复制源码）。对比点：完整 ICMP 类型集、ICMPv6 PTB 与 NDP 的实际配合、差错生成与速率限制（`icmp_global_ratemlimit`）、以及 IPv4 对 ICMPv4 差错向传输层（UDP/TCP）的反馈机制（lwIP 在 `icmp.c` 文件头注释中明确「将某些 ICMP 消息传给传输协议——未实现」，见 icmp.c:39-40）。
- **BSD ping / traceroute**：发送方视角（echo 请求的 id/seqno 匹配、TTL 探测与「time exceeded」响应配合），可与 lwIP 接收方路径对照。
- **net-tools / iputils `ping`（Linux）**：观察 ICMPv4/v6 echo 报文的 wire format 与校验和计算。

## 阅读备注

- **ICMPv4 实现是「薄入口」**：`icmp.c` 只实现 echo 应答与差错发送；文件头注释（icmp.c:39-40）明示「有些 ICMP 消息应传给传输协议——未实现」，即 lwIP 对 ICMP 差错（DUR/TE）**不向 TCP/UDP 层反馈**，与 Linux 不同。
- **ICMPv6 实现是「入口路由器」**：`icmp6_input` 把 NS/NA/RA/RD/PTB 转给 `nd6_input`、MLQ/MLR/MLD 转给 `mld6_input`。阅读本模块时只关注分流边界，NDP/MLD 机制属邻居发现/组播模块。
- **lwIP 的上下文传递设计**：IPv6 差错响应的源地址选择依赖 `ip6_current_*` 上下文与 zone；`icmp6_time_exceeded_with_addrs` 是「延迟响应」的专门入口，是最能体现 lwIP 如何在无状态协议上保持「响应与触发包同上下文」这一不变量的样例（icmp6.c:273-277）。
- **协议取舍点（对照表）**：校验和范围（IPv4 本体 vs IPv6 伪头部）、差错回带长度（8 vs ≤1232）、分片模型（路由器分片 vs 路由器不分片+PTB）、类型空间组织（平铺 vs 错误/信息二分）——详见 `protocol.md`「设计取舍」。
- **勘误记录**：`icmp6.c` 头注释「RFC 4443」按上游原样保留；规范编号勘误见上（lwIP 注释沿用旧编号，现行 ICMPv6 规范编号以 rfc-editor.org 为准）。