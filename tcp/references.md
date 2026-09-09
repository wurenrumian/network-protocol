# TCP · references

## 规范 / 标准

- **RFC 793** — *Transmission Control Protocol*。TCP 的权威定义：报文格式、状态机、序列号语义、连接建立/关闭、2MSL 与 TIME-WAIT。
- **RFC 1122** — *Requirements for Internet Hosts*。主机要求，含 TCP 分层、紧急指针、keepalive 等补充约束。
- **RFC 5681** — *TCP Congestion Control*（取代 RFC 2581/2001）。定义慢启动、拥塞避免、快速重传、快速恢复与 `ssthresh`/`cwnd` 调整规则；lwIP 的 `tcp_rexmit_rto_commit()` 等实现遵循其建议值。
- **RFC 6298** — *Computing TCP's Retransmission Timer*。RTO 计算：初始 RTO、指数退避、RTT 采样与 Karn 算法；对应 `tcp_out.c` 中 `rto`/`backoff` 的维护。
- **RFC 2581** — *TCP Congestion Control*（历史版本，被 5681 取代）。
- **RFC 2001** — *TCP Slow Start, Congestion Avoidance, Fast Retransmit, and Fast Recovery*（历史版本，被 2581 取代）。
- **RFC 2018 / RFC 2883** — *TCP Selective Acknowledgment*。SACK 选项与重复 ACK 语义；对应 `tcp_parseopt()` 与 `tcp_add_sack()`。
- **RFC 1323** — *TCP Extensions for High Performance*。窗口扩大因子与时间戳选项；对应 `tcp_build_wnd_scale_option()`、`tcp_build_timestamp_option()`。
- **RFC 5682** — *SACK-based Congestion Control*（SACK 下的快速恢复补充，可作延伸阅读）。
- 关联标准：RFC 791（IP，承担寻址与分片）、RFC 6261 相关 SNMP MIB（`snmp_mib2_tcp.c`，可略）。

## 论文

- Van Jacobson — *Congestion Avoidance and Control*（1988）。拥塞窗口与慢启动的奠基工作，快速重传/恢复的思想来源。
- R. Braden 等 — *RFC 1323*（高性能扩展，也可归为规范）。

## 上游仓库（固定版本 / commit）

- 主实现仓库：**github.com/lwIP-tcpip/lwip**。
- 固定 tag：`STABLE-2_1_3_RELEASE`（2.1.3）。
- tag 实际解析到的 commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`（tag 对象 `f01ec11c7bd0eddc786d5d9068ecf2b941b061b7` 指向该 commit，已核实）。
- 文件来源：`src/core/tcp.c`、`src/core/tcp_in.c`、`src/core/tcp_out.c`、`src/include/lwip/tcp.h`、`src/include/lwip/priv/tcp_priv.h`、`src/include/lwip/prot/tcp.h`；许可证 `COPYING`。
- 注意：2.1.3 已无独立 `src/core/tcp_tmr.c`，TCP 定时器（`tcp_tmr`/`tcp_fasttmr`/`tcp_slowtmr`）位于 `src/core/tcp.c` 中。详见 `src/README.md`「未复制的依赖 / 已复制·跳过说明」。

## 其他实现

- **Linux 内核** `net/ipv4/tcp_*.c`：多种拥塞控制算法（Reno/NewReno/Vegas/CUBIC）、SYN cookies、SACK 完整实现。对照重点是「内核态多线程 vs lwIP 单线程」与算法插件架构。
- **mTCP**：面向多核的用户态 TCP，侧重数据路径与线程伸缩，作为高性能对照（只读不复制）。
- **Seastar**：基于 SCTP/TCP 的异步框架，与 mTCP 同作吞吐取舍对照。
- **4.4BSD / FreeBSD TCP**：经典实现，是 lwIP 行为的上游参照（可选）。
- **picoTCP / uIP**：其他嵌入式协议栈，可比较 PCB 与内存管理的取舍（可选）。

## 阅读备注

- 状态机以 `protocol.md` 与 `state-machine.md` 为准；源码中以 `[STATE]`、`[INVARIANT]`、`[BOUNDARY]`、`[RFC: ...]` 注释标记。
- 闭环示例：「收到 ACK 推进发送窗口」：`tcp_input()` → `tcp_process()` → `tcp_receive()` 的 ACK 校验 → `tcp_free_acked_segments()` 释放 `unacked` → `tcp_output()` 依据窗口重发/续发。
- 学习注释仅加在 `src/upstream/` 副本上；不修改上游控制流与命名。若发现明显错误，加补丁文件并在本文件说明。
- 观察记录如抓包（SYN/ACK 时序、重复 ACK、TIME-WAIT 持续 2MSL）可写入 `observations.md`（本目录目前未创建）。