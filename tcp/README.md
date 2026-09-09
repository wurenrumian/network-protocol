# TCP

## 定位

本模块位于协议学习主干「传输层」一节，前置于 DNS / TLS / HTTP 等应用层协议（见根目录 `protocol-learning-design.md` §4.4、§7）。TCP 在 IP 之上提供**可靠字节流**：

- 面向连接：显式建立/关闭，状态机管理连接生命周期；
- 可靠交付：序列号、确认、重传，把不可靠的 IP 数据报改造成无差错、不重复、保序的字节流；
- 流量控制：接收窗口限制发送速率，防止淹没接收端；
- 拥塞控制：发送端自适应网络容量，防止压垮中间链路；
- 关闭与 TIME-WAIT：半关闭语义与 2MSL 等待，保证迟到的报文不会污染新连接。

明确不负责：寻址与转发（IP）、端口多路复用之外的会话语义（SCTP）、加密与 0-RTT（QUIC/TLS）。

## 前置模块

- 协议抽象与报文编码（字节序、校验、选项/长度边界，§4.1）
- Ethernet / ARP / IPv4 / ICMP（下层的分段、MTU、路径与接口模型，§4.2–4.3）
- UDP（端口复用与校验，作为传输层对照起点，§4.4）

## 推荐阅读顺序

1. **protocol.md**：先建立问题定义、抽象对象与 wire format，再读核心机制。
2. **state-machine.md**：对照 RFC 793 状态图，掌握 11 个状态与正常/异常转移。
3. **src/README.md**：按「收到 ACK → 推进发送窗口」的闭环进入源码。
4. **src/upstream/src/include/lwip/tcp.h** 与 **priv/tcp_priv.h**：`tcp_pcb` 数据结构。
5. 沿闭环补读 `src/core/tcp_in.c`（收包）→ `src/core/tcp_out.c`（发送/重传）→ `src/core/tcp.c`（定时器/关闭）。
6. **references.md**：按 RFC 793/5681/6298 对照实现取舍。

## 源码入口

见 [`src/README.md`](src/README.md)。核心闭环入口：

- 收包：`tcp_input()`（`src/core/tcp_in.c`）→ `tcp_process()` → `tcp_receive()`
- 发送推进：ACK 到达 → `tcp_free_acked_segments()` 释放队列 → `tcp_output()`
- 定时器：`tcp_tmr()` → `tcp_fasttmr()` / `tcp_slowtmr()`（均在 `src/core/tcp.c`）

## 主实现 / 对照实现

- 主实现：**lwIP 2.1.3**（`src/core/tcp.c`、`tcp_in.c`、`tcp_out.c`，头文件在 `src/include/lwip/`），见 `protocol-learning-design.md` §4.0。
- 对照实现：Linux 内核 `net/ipv4/tcp_*`（参考拥塞控制多种算法）、mTCP / Seastar（高性能数据路径，仅比较取舍，不复制源码）。
- 版本固定：仓库 `github.com/lwIP-tcpip/lwip`，tag `STABLE-2_1_3_RELEASE`。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。上游源码保留相对路径置于 `src/upstream/`，许可证置于 `src/LICENSES/`；学习注释直接在副本上添加，不改动原有控制流与命名。