# TCP · protocol

## 问题定义

TCP 在不可靠、可能乱序、可能重复的 IP 数据报服务之上，提供**面向连接的可靠字节流**。协议要解决五组问题，并明确不负责的部分：

1. **连接标识**：以四元组（源 IP、源端口、目的 IP、目的端口）唯一标识一条端到端连接。
2. **可靠有序交付**：把字节流切成分段（segment），用序列号与确认号实现无差错、不重复、保序的重组；接收方必须能处理乱序、重复、部分到达的数据。
3. **流量控制**：接收方用**接收窗口**（advertised window）告知自己的缓冲能力，发送方不得超过该窗口发送。
4. **拥塞控制**：发送方自行探测网络容量，用拥塞窗口限制在途数据，避免压垮中间链路。
5. **有序关闭**：支持全双工的半关闭（各自独立发 FIN），并处理「关闭后仍有旧报文到达」的遗留问题。

不负责的部分：寻址与转发（IP 层）、消息边界（TCP 是字节流，消息分界由应用自行添加）、会话保持与多媒体适配（SCTP）、加密与多路复用（TLS、QUIC）。

主实现 lwIP 2.1.3 对应三个核心文件：`tcp.c`（控制块、定时器、关闭）、`tcp_in.c`（收包与状态推进）、`tcp_out.c`（发送、重传、ACK）；慢/快定时器函数 `tcp_tmr()`/`tcp_fasttmr()`/`tcp_slowtmr()` 位于 `tcp.c` 内。

## 抽象对象

- **连接控制块 `tcp_pcb`**（`src/include/lwip/priv/tcp_priv.h`）：每条连接的全部状态。关键字段：
  - 标识：本地/远端 `ip_addr` 与端口；
  - 序列号：`snd_wnd`（发送窗口）、`snd_wl1/snd_wl2`（窗口更新校验）、`snd_nxt`（下一个待发送的字节）、`snd_una`（尚未被确认的最早字节，`unacked` 队列的起点）；
  - 确认号：`rcv_nxt`（期望收到的下一个字节）、`rcv_wnd`（接收窗口，发送给对端）；
  - 队列：`unsent`（待发送分段）、`unacked`（已发送未确认）、`ooseq`（收到的乱序分段）；
  - 定时与重传：`rttest`/`rtime`（RTT 测量）、`rto`、`nrtx`（重传计数）、`backoff`；
  - 拥塞控制：`cwnd`、`ssthresh`、`dupacks`（连续重复 ACK 计数）；
  - 标志：`flags`（TF_* 各功能开关）、`state`（连接状态）。
- **分段 `tcp_seg`**（`src/include/lwip/tcp.h`）：`tcp_pcb` 队列中挂载的发送/接收单元，包含 `tcp_hdr` 与负载数据。
- **监听 PCB**：`tcp_pcb_listen` 与 `union tcp_listen_pcbs_t`，LISTEN 状态控制块以专用结构保存在独立链表，避免每连接分配完整控制块。
- **报文首部 `tcp_hdr`**（`src/include/lwip/prot/tcp.h`）：wire format 的直接映射，见下节。

## wire format

**`tcp_hdr`**（`src/include/lwip/prot/tcp.h`）：

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Source Port          |       Destination Port        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Sequence Number                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Acknowledgment Number                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Data |           |U|A|P|R|S|F|                               |
| Offset| Reserved  |R|C|S|S|Y|I|            Window              |
|       |           |G|K|H|T|N|N|                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           Checksum            |        Urgent Pointer         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Options                    |    Padding    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- 字段：源/目的端口、序列号 `seqno`、确认号 `ackno`、`_hdrlen_rsvd_flags`（头长/保留/标志合成一个 16 位字段）、`wnd`、校验和、紧急指针，之后是选项与填充。
- lwIP 用宏 `TCPH_HDRLEN()`、`TCPH_FLAGS()`、`TCPH_SET_FLAG()` 等从合成字段中取位（`prot/tcp.h`）。
- **标志**（TCP_FLAGS 与各 TCP_*_FLAG，见 `prot/tcp.h`）：URG、ACK、PSH、RST、SYN、FIN。
- **选项**（`tcp_parseopt`，`tcp_in.c`）：MSS（`TCP_OPT_MSS`）、窗口扩大因子（`TCP_OPT_WND_SCALE`）、SACK 允许与 SACK 块（`TCP_OPT_SACK`、`TCP_OPT_PERM`）、时间戳（`TCP_OPT_TS`）。lwIP 的选项解析与构造分别集中在 `tcp_in.c` 的 `tcp_parseopt()` 和 `tcp_out.c` 的 `tcp_output_fill_options()`。

序列号、确认号、窗口均为无符号整数，用**序列空间回绕**语义比较大小（`TCP_SEQ_LT`/`TCP_SEQ_GEQ` 等，见 `tcp_priv.h`），这是处理 32 位回绕的关键不变量。

## 核心机制

### 连接建立

- 主动方 `tcp_connect()` 分配 `tcp_pcb`、填充四元组、初始化序列号，发送 SYN 并进入 SYN-SENT；被动方在 `tcp_listen_input()` 中分配控制块、记录初始序列号、进入 SYN-RCVD 并回 SYN+ACK。
- 三次握手：SYN → SYN+ACK → ACK。SYN 占用一个序列号，因此 `snd_nxt`、`rcv_nxt` 在握手中即被推进；ACK 只确认 SYN，无数据负载。
- 监听控制块与连接控制块分离：`tcp_pcb_listen` 不包含完整发送/接收状态。

### 序列号与确认

- 发送侧：`snd_una ≤ 已发送未确认的起点`，`snd_nxt` 指向下一个待用序列号。收到 ACK 时，只要 `ACK > snd_una` 就推进 `snd_una`（`tcp_receive` 中的 ACK 处理），释放 `unacked` 队列中已被确认的分段。
- 接收侧：`rcv_nxt` 期望下一个字节。到达分段若恰好等于 `rcv_nxt`，顺序交付并推进；若大于 `rcv_nxt` 则插入 `ooseq` 并立即回 ACK；若落在窗口内但重复，丢弃并立即回 ACK（帮助对端触发快速重传）。
- 窗口校验：只有收到的窗口信息确实「更新」（用 `snd_wl1/snd_wl2` 判序）才覆盖 `snd_wnd`，防止旧报文回退窗口。

### 重传

- **超时重传（RTO）**：`tcp_slowtmr()` 对 `rto` 超时未确认的分段调用 `tcp_rexmit_rto_*`；`backoff` 指数退避，超过最大重传次数（`TCP_MAXRTX`）则中止连接。
- **快速重传**：`tcp_receive()` 统计连续重复 ACK（`dupacks` 计数），收到 3 个重复 ACK（`dupacks >= 3`）时调用 `tcp_rexmit_fast()` 立即重传，不等超时。
- **SACK**：若协商了 SACK，重传可只发送未确认区间（`tcp_add_sack` / `tcp_remove_sacks_*`）。

### 流量控制

- 接收方通过 ACK 的 `wnd` 字段通告剩余接收能力；发送方以 `snd_wnd = min(对端通告窗口, 本地拥塞窗口)` 约束在途数据。
- **Nagle 算法**（`tcp_do_output_nagle`）：小报文（不足一个 MSS）等到前一批被确认或凑满一个 MSS 再发送，降低小报文数量；应用要求低延迟时用 `tcp_set_flags(TCP_NODELAY)` 关闭。
- **延迟 ACK**：lwIP 由 `tcp_tmr()` 的 `tcp_fasttmr()` 驱动 ACK 定时器（约 250 ms），把多个到达的分段合并确认。
- 零窗口处理：对端窗口为 0 时，发送方停止发送，由 `tcp_keepalive()`/窗口探测（`tcp_ack_now` 的探测机制）周期探测对端窗口是否恢复。

### 拥塞控制

- **慢启动**：每个被确认的字节使 `cwnd` 增大（lwIP 按全窗口 ACK 增大），指数增长直到 `ssthresh`。
- **拥塞避免**：`cwnd ≥ ssthresh` 后线性增长。
- **快速恢复**：进入拥塞避免。
- **超时**：`tcp_slowtmr()` 重传时把 `ssthresh` 降为 `max(2*MSS, cwnd/2)`、`cwnd` 回退到 `MSS`（RFC 5681 建议值），并用 `TCPWND_MIN16` 等宏限制下界。
- lwIP 在 `tcp_rexmit_rto_commit()` 与 `tcp_receive()` 的 ACK 推进处维护 `cwnd` 的增减，实现与收发闭环绑定。

### 关闭与 TIME-WAIT

- 关闭分两个方向独立进行：一端发送 FIN（`tcp_enqueue_flags`），对端回 ACK 并进入 CLOSE-WAIT（应用可继续发数据）；对端发送自己的 FIN 后进入 LAST-ACK。
- **TIME-WAIT**：主动关闭方在收到对端 FIN 后进入 TIME-WAIT，等待 `2 * TCP_MSL`（lwIP 的 `TCP_MSL` 为 60000 ms，即 120 秒；`tcp_slowtmr` 以 `2 * TCP_MSL / TCP_SLOW_INTERVAL` 判定到期）后释放控制块，确保本端最后发出的 ACK 能到达对端、且旧连接报文不会污染新连接。
- 半关闭（`tcp_shutdown`）允许只关闭发送方向。CLOSE-WAIT/FIN-WAIT-2 也有超时（`TCP_FIN_WAIT_TIMEOUT`）防止无限悬挂。
- 异常：收到 RST 立即中止；`tcp_abort()`/`tcp_abandon()` 处理应用异常退出或对端 RST；`tcp_timewait_input()` 对 TIME-WAIT 中的新数据报文做最小化应答，不重建连接。

## 设计取舍

- **用户态协议栈**：lwIP 不依赖操作系统套接字，`tcp_pcb` 直接嵌入 `pbuf`/`netif` 抽象，用回调把数据交付给应用（`tcp_arg`/`tcp_recv` 回调），而不是独立内核线程。代价是应用必须配合事件驱动模型。
- **控制块与监听结构分离**：大量 LISTEN 连接不占用完整 PCB，省内存；但需要 `tcp_pcb_listen` 与 `tcp_pcb` 两套结构。
- **内存管理单元 `pbuf`**：分段由 `pbuf` 链表示，发送/接收队列复用同一机制，减少拷贝。
- **定时器合并**：快/慢定时器合并到 `tcp_tmr()`（250 ms / 500 ms 档），简化调度，牺牲精度（如 RTO 最小 500 ms 量级）。
- **单线程假设**：lwIP 收包处理不做并发，`tcp_input` 串行执行，避免锁竞争；代价是吞吐受限，故高性能路径需另读 mTCP/Seastar。
- **ACK 发送策略**：延迟 ACK 与立即 ACK 混合（乱序/重复立即应答），在批量化与低延迟间折中。
- **不实现部分高级特性**：如 Linux 的多个拥塞算法插件、SACK 限制等，仅实现 RFC 基本算法，换取可移植与可读。

## 不变量

- **序列号不倒退**：`snd_una`、`snd_nxt`、`rcv_nxt` 只单调推进（用回绕比较）；ACK 校验保证不确认未发送的数据（`TCP_SEQ_LEQ`）。
- **队列单调**：`unacked` 中的分段序列号连续且不重叠，从 `snd_una` 开始；`ooseq` 按序列号有序，互不重叠。
- **发送窗口约束**：任何时刻在途未确认字节数 `≤ min(snd_wnd, cwnd)`；`unsent` 队列中的分段只有窗口允许时才出队发送。
- **接收窗口诚实**：`rcv_wnd` 反映 `tcp_pcb` 接收缓冲的实际可用空间（与 `rcv_queuelen`/`rcv_buf` 一致）。
- **PCB 归属单一链表**：每个非 CLOSED 控制块恰在一个 `tcp_*_pcbs` 链表中（LISTEN 链、bound 链、active 链或 TIME-WAIT 链），`tcp_tmr` 遍历时无重复处理。
- **关闭后不重用**：TIME-WAIT 未结束前，相同四元组的新连接不直接复用（由 `tcp_timewait_input` 处理旧报文）。
- **状态-结构一致性**：状态为 ESTABLISHED 才允许数据收发；SYN-RCVD 持有 `tcp_pcb_listen` 的引用以完成握手回调。

## 边界条件与异常处理

- **序列号回绕**：32 位序列空间在高速长连接下会回绕，所有大小比较必须用 `TCP_SEQ_LT` 等回绕安全比较，否则窗口计算错误。
- **窗口更新乱序**：用 `snd_wl1/snd_wl2` 判断 ACK 携带的窗口是否比上次新，防止旧 ACK 把窗口回退。
- **重复/乱序报文**：窗口内重复 → 丢弃并立即 ACK；乱序 → `ooseq` 插入并按 `rcv_nxt` 补齐；窗口外 → 丢弃（不缓存），防止内存耗尽。
- **对端关闭方向后仍发数据**：半关闭期间接收方向仍开放，数据照常交付，仅发送方向停。
- **CLOSE-WAIT / FIN-WAIT-2 悬挂**：应用不及时关闭，连接悬挂占用 PCB，lwIP 用 `TCP_FIN_WAIT_TIMEOUT`（20 s）强制回收。
- **重传上限**：SYN/数据重传次数超限（`TCP_MAXSYNRTX`/`TCP_MAXRTX`）即 `tcp_abort`，避免无限占用资源。
- **SYN flood**：LISTEN 队列满（backlog）时拒绝新连接并回 RST（`tcp_listen_input`），防止内存耗尽。
- **RST 处理**：任何状态收到合法 RST 即终止连接并释放资源（`tcp_process` 中的 `TCP_EVENT_ERR`）。
- **零窗口死锁**：对端窗口为 0 时停止发送，靠窗口探测（`tcp_keepalive`/ACK 驱动的探测）恢复，避免双方互等。
- **TIME-WAIT 中的新报文**：`tcp_timewait_input()` 对旧连接报文仅回 ACK（或在收到新 SYN 时按规则应答），不进入握手，保证 2MSL 隔离语义。