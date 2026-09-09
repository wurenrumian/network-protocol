# UDP · references

## 规范 / 标准

- **RFC 768 — User Datagram Protocol**（1980）。UDP 基础规范：8 字节头、端口、长度、可选校验和、尽力而为语义。无连接、无确认、无重传。
- **RFC 6935 — IPv6 and UDP Checksums for Tunneled Packets**（2013）。说明 IPv6 下 UDP 校验和必选；`chksum = 0` 仅用于 IPv4，IPv6 无「关闭校验和」选项。
- **RFC 6936 — Applicability Statement for the Use of IPv6 UDP Datagrams with Zero Checksums**（2013）。讨论 tunneled 场景中校验和为 0 的适用条件与限制；补充 RFC 6935 的适用性说明。
- **RFC 8085 — UDP Usage Guidelines**（2017）。UDP 应用设计指南：尽力而为语义、回退/超时、路径 MTU、IP 分片、应用层流控与拥塞控制建议。（选读）
- **RFC 791（IPv4）/ RFC 8200（IPv6）**：伪头字段来源，UDP 校验和依赖 IP 头地址。

## 论文

无直接对应论文；相关背景见：
- **The End-to-End Arguments in System Design**（Saltzer/Reed/Clark, 1984）：论证为何把可靠性交给端到端层，与 UDP 把可靠性完全交给上层的设计一致。（背景参考）

## 上游仓库（固定版本 / commit）

- 仓库：github.com/lwIP-tcpip/lwip
- 版本 / tag：`STABLE-2_1_3_RELEASE`（lwIP 2.1.3）
- commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 原始文件路径：
  - `src/core/udp.c`
  - `src/include/lwip/udp.h`
  - `src/include/lwip/prot/udp.h`
  - `COPYING`（许可证）
- 下载源：`https://raw.githubusercontent.com/lwIP-tcpip/lwip/STABLE-2_1_3_RELEASE/<path>`

## 其他实现

- **Linux 内核**：`net/ipv4/udp.c`、`net/ipv6/udp.c`。哈希表端口查找、reuseport/reuseaddr 复用策略、软件/硬件校验和 offload、early demux。
- **FreeBSD**：`sys/netinet/udp_usrreq.c`。`udp_input`、PCB 哈希、校验和与 reassembly 策略。
- **musl libc**：`src/network/udp.c`（socket 层视角，非协议栈）。
- **轻量协议栈对照**：`picoTCP`、`uIP`（lwIP 前身）、`RT-Thread lwIP 端口`。

## 阅读备注

- lwIP 是嵌入式用户态协议栈，PCB 链表 + 顺序查找与内核哈希表是主要实现差异；阅读时关注 `udp_input` 内遍历的匹配优先级（connected → bound → wildcard），这是端口复用语义的实现点。
- 校验和算法在 `inet_chksum_pseudo`/`ip6_chksum_pseudo`，位于 `src/core/inet_chksum.c`（本模块未复制，属未复制依赖）。
- `udp_input` 由 IP 层调用，需理解 `ip4_input`/`ip6_input` 的 protocol 分发，属 integration 类别（未复制）。
- 若发现上游源码存在需要修正的错误，采用补丁文件并在本文件记录，不修改 `src/upstream/` 下原文件。