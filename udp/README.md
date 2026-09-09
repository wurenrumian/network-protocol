# UDP

## 定位

UDP（RFC 768）是传输层最简协议：在 IP 之上提供进程到进程的寻址（端口）、尽力而为的交付、可选的校验和，以及无连接的多路复用。它不负责可靠性、顺序、流控、拥塞控制或重传——这些被明确地留给上层（应用或更高层协议如 QUIC）。

本模块位于协议主干中「IPv4 / IPv6 / ICMP」之后、「TCP」之前（见 `protocol-learning-design.md` §4.4）。阅读重点：

- **端口复用**：同一端口如何被多个 PCB（Protocol Control Block）共享，查找与分发规则；
- **校验和**：含 IPv4/IPv6 伪头（pseudo-header）的计算范围与校验路径；
- **尽力而为交付**：无连接、无确认、无重传，出错即丢弃；
- **无连接模型**：PCB 的 bound/connected 状态与 `udp_sendto` 的寻址方式。

## 前置模块

- **协议抽象与报文编码**（§4.1）：字节序、长度/边界、校验和等分析语言。
- **IPv4 / IPv6 / ICMP**（§4.3）：UDP 依赖 IP 层寻址与交付，校验和伪头需要 IP 头字段；`ip4_input`/`ip6_input` 按 protocol 字段把载荷上抛给 `udp_input`。
- 链路层与 ARP 作为间接依赖，仅在追踪完整收发路径时涉及。

## 推荐阅读顺序

1. 读 `protocol.md`：先建立问题定义、wire format（`udp_hdr`、伪头校验和）与核心机制。
2. 读 `state-machine.md`：理解 UDP 无显式状态机，只有 PCB 的 bound/connected 两种绑定状态，以及收/发两条处理流程。
3. 进入 `src/README.md`，按调用链读源码：
   - 先读 `src/include/lwip/prot/udp.h`（wire format，`udp_hdr`）；
   - 再读 `src/include/lwip/udp.h`（PCB 结构、API 原型）；
   - 最后读 `src/core/udp.c`（端口表、查找/复用、收/发主路径）。
4. 对照 `references.md` 中的 RFC 与其他实现，比较设计取舍。

## 源码入口

- 源码导航：`src/README.md`。
- 上游文件（保留原始相对路径）：`src/upstream/src/core/udp.c`、`src/upstream/src/include/lwip/udp.h`、`src/upstream/src/include/lwip/prot/udp.h`。
- 关键入口函数：收包 `udp_input`（由 `ip4_input`/`ip6_input` 调用）、发送 `udp_sendto`/`udp_send`、绑定 `udp_bind`、连接 `udp_connect`、端口查找在 `udp_input` 内遍历 `udp_pcbs`、校验 `udp_input` 内的校验分支与 `inet_chksum_pseudo`。

## 主实现 / 对照实现

- **主实现**：lwIP 2.1.3（`STABLE-2_1_3_RELEASE`，commit `6ca936f6b588cee702c638eee75c2436e6cf75de`），见 `references.md`。
- **对照实现**：Linux 内核 `net/ipv4/udp.c`（UDP 哈希表与 reuseport 分发）、FreeBSD `udp_usrreq.c`、musl `src/network/udp.c`（socket 层视角）。对照重点：端口复用策略与校验和的实现差异。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。