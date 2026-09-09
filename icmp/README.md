# ICMP / ICMPv6

## 定位

ICMP（RFC 792）与 ICMPv6（RFC 4443）是 IP 层的控制消息协议，不承载应用数据，而是以「差错报告 + 探测/通知」两种方式支撑网络层的运行：

- 差错报告：目标不可达、超时、参数问题、分片超限（ICMPv6 Packet Too Big），把转发失败的原因反馈给源节点；
- 探测与通知：echo request/reply 提供可达性与往返时延探测（ping）；ICMPv6 中还承载 PMTU 通知（Packet Too Big）和邻居发现（NDP，NS/NA/RS/RA/Redirect）等类型的消息。

在 §4.3 主干中，本模块位于 IPv4/IPv6 之后，回答两个问题：

1. 当 IP 无法投递或 TTL 耗尽时，如何把原因告知源？差错报文应带回原始报文的前缀，才能定位到具体传输连接；
2. 诊断类消息（echo）与控制类消息（ICMPv6 中的 NDP、MLD）如何共存在同一协议框架下，又与相邻协议如何分工。

明确不负责：ICMP 不负责重传、不保证送达，差错报文本身上限约等于「尽力而为再尽力一次」。ICMPv6 中的邻居发现由 NDP 实现（nd6 模块），组播监听由 MLD（mld6）实现，两者在 lwIP 中虽然共享 ICMPv6 的类型空间与入口，但机制上属于邻居发现/组播协议，本模块只覆盖它们与 ICMPv6 入口的分流边界。

## 前置模块

- 协议抽象与报文编码（字节序、长度与边界、校验和）
- 链路层：Ethernet 帧、netif 抽象
- 网络层：IPv4 / IPv6（lwIP `ip.c`、`ip6.c`：`ip_input`/`ip6_input` 如何按 next-header 分发到 ICMP；`ip4_output_if`/`ip6_output_if` 如何把 ICMP 报文发出）
- IPv6 邻居发现 NDP / MLD（了解 ICMPv6 入口把 NS/NA/RA/PTB/MLQ/MLR/MLD 转交给谁）

## 推荐阅读顺序

1. `protocol.md`：问题定义、wire format（ICMP/ICMPv6 头、type/code、echo、差错报文限制）、核心机制与 ICMPv4 vs ICMPv6 取舍；
2. `state-machine.md`：无显式状态机的处理流程（收包 → 类型分发 → 响应/差错/转交；发错包 → 差错生成），及几条关键时序；
3. `src/README.md`：上游文件清单、入口/结束函数、调用链与未复制依赖；
4. `src/upstream/src/core/ipv4/icmp.c` 与 `src/upstream/src/core/ipv6/icmp6.c`：按调用链标注的源码；
5. `src/upstream/src/include/lwip/prot/icmp.h`、`icmp6.h`：报文结构定义；
6. `references.md`：RFC 与仓库版本。

## 源码入口

见 `src/README.md`。核心文件：

- `src/upstream/src/core/ipv4/icmp.c`：入口 `icmp_input`；出口 `icmp_dest_unreach`、`icmp_time_exceeded`
- `src/upstream/src/core/ipv6/icmp6.c`：入口 `icmp6_input`；出口 `icmp6_dest_unreach`、`icmp6_packet_too_big`、`icmp6_time_exceeded`、`icmp6_param_problem`
- `src/upstream/src/include/lwip/prot/icmp.h`、`icmp6.h`：`struct icmp_echo_hdr`、`struct icmp6_hdr`、`struct icmp6_echo_hdr`、类型/代码常量

## 主实现 / 对照实现

- 主实现：lwIP 2.1.3（tag `STABLE-2_1_3_RELEASE`，commit `6ca936f6b588cee702c638eee75c2436e6cf75de`），仓库 `github.com/lwIP-tcpip/lwip`（见 `protocol-learning-design.md` §4.0）
- 对照实现（参考，不复制源码）：Linux 内核 `net/ipv4/icmp.c`、`net/ipv6/icmp.c`（完整 ICMPv4/v6 实现，含 PTB 与 NDP 的实际配合）；BSD `ping`/`traceroute` 作为发送方观察点

## 目录规范

参见根目录 `protocol-learning-design.md` §3。