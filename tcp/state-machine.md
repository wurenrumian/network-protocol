# TCP · state-machine

## 状态

TCP 有 11 个显式状态（RFC 793 §3.2）。lwIP 在 `tcp_priv.h` 中用枚举表示，各状态的名字在 `tcp.c` 的 `tcp_debug_state_str` 中输出。

| 状态 | 含义 | 进入条件 |
| --- | --- | --- |
| CLOSED | 无连接，控制块空闲/待回收 | 初始化、连接结束 |
| LISTEN | 被动监听，等待 SYN | 应用 `tcp_bind`+`tcp_listen` |
| SYN-SENT | 已发 SYN，等待 SYN+ACK | 主动 `tcp_connect` |
| SYN-RCVD | 已收 SYN 且已回 SYN+ACK，等待最终 ACK | 三次握手第二步（LISTEN 收到 SYN 后） |
| ESTABLISHED | 连接已建立，可收发数据 | 握手完成 |
| FIN-WAIT-1 | 已发 FIN，等待对端 ACK | 主动关闭第一步 |
| FIN-WAIT-2 | FIN 已被确认，等待对端 FIN | 主动关闭第二步 |
| CLOSE-WAIT | 已收对端 FIN，已回 ACK，等待本端应用关闭 | 被动关闭 |
| CLOSING | 双方同时发 FIN，等待对端 ACK 自己的 FIN | 同时关闭 |
| LAST-ACK | 已发本端 FIN，等待对端最终 ACK | CLOSE-WAIT 中应用关闭 |
| TIME-WAIT | 已收对端 FIN 并回最终 ACK，等待 2MSL 后回收 | 主动关闭完成 |

## 事件

驱动状态转移的事件包括：

- 用户事件：`connect`（主动连接）、`close`/`shutdown`（关闭/半关闭）、`send`（发送数据）、`abort`（异常终止）。
- 报文事件：SYN、SYN+ACK、ACK、FIN、RST 以及携带数据/选项的普通分段。
- 定时事件：`tcp_tmr()` 驱动的快/慢定时器（重传、ACK 聚合、TIME-WAIT 到期、FIN-WAIT-2 超时、keepalive）。
- 资源事件：LISTEN backlog 满、PCB 分配失败。

## 状态转移

### 正常时序（三次握手）

```
CLOSED --(tcp_connect, 发 SYN)--> SYN-SENT --(收 SYN+ACK, 发 ACK)--> ESTABLISHED
CLOSED --(tcp_listen)--> LISTEN --(收 SYN, 发 SYN+ACK)--> SYN-RCVD
SYN-RCVD --(收 ACK)--> ESTABLISHED
```

### 正常时序（四次挥手，主动关闭方）

```
ESTABLISHED --(应用 close, 发 FIN)--> FIN-WAIT-1
FIN-WAIT-1 --(收对端 ACK)--> FIN-WAIT-2
FIN-WAIT-2 --(收对端 FIN, 发 ACK)--> TIME-WAIT --(2MSL 到期, tcp_slowtmr)--> CLOSED
```

### 正常时序（被动关闭方）

```
ESTABLISHED --(收对端 FIN, 发 ACK)--> CLOSE-WAIT --(应用 close, 发 FIN)--> LAST-ACK
LAST-ACK --(收对端 ACK)--> CLOSED
```

### 同时关闭

```
ESTABLISHED --(双方各自发 FIN)--> FIN-WAIT-1 与 CLOSE-WAIT 并存
FIN-WAIT-1 --(收对端 FIN, 发 ACK)--> CLOSING --(收对端 ACK)--> TIME-WAIT
```

### 异常转移

```
任意状态 --(收 RST)--> CLOSED（tcp_abort，回调应用 err）
SYN-SENT --(收 RST)--> CLOSED
SYN-SENT --(收 SYN+ACK 且序列号/端口不符)--> 回 RST 保持 SYN-SENT
LISTEN --(收 ACK 而非 SYN)--> 回 RST
FIN-WAIT-2 --(FIN_WAIT_TIMEOUT 到期)--> CLOSED（lwIP 的防御性回收）
TIME-WAIT --(收到新 SYN，四元组相同)--> 按 RFC 可回复或重开（lwIP 用 tcp_timewait_input 最小应答）
```

## 正常 / 异常时序

### 正常握手与关闭（含 lwIP 处理路径）

```
客户端                                  服务器
  |----- SYN (seq=x) ------------------>|
  |                                      |-- tcp_input -> tcp_listen_input(创建 PCB, SYN_RCVD)
  |<---- SYN+ACK (seq=y, ack=x+1) -------|
  |-- tcp_process(SYN_SENT: 校验 ack,    |
  |   回 ACK y+1, ESTABLISHED)          |
  |----- ACK (ack=y+1) ----------------->|-- tcp_process(SYN_RCVD -> ESTABLISHED)
  |=== 双向数据交换（tcp_receive 推进 rcv_nxt / 发送侧 tcp_output） ===|
  |-- 应用 close, 发 FIN -------------->|-- tcp_input -> tcp_process(ESTABLISHED:
  |                                     |   收 FIN -> CLOSE_WAIT, 立即回 ACK)
  |<---- ACK -----------------------------|
  |-- FIN_WAIT_1 -> FIN_WAIT_2           |-- 应用 close, 发 FIN
  |<---- FIN -----------------------------|-- LAST_ACK
  |-- 收 FIN: 发 ACK -> TIME_WAIT        |
  |----- ACK (最终 ACK) ---------------->|-- 收 ACK: LAST_ACK -> CLOSED, 释放 PCB
  |-- 2MSL 到期, tcp_slowtmr 回收 PCB -->|
```

### 异常时序示例

1. **乱序数据**：接收方 `rcv_nxt=100`，先到 seq=200 的分段 → 不交付，插入 `ooseq`，立即回 ACK(100)；seq=100 到达后 `tcp_receive` 顺序交付并连带交付 `ooseq` 中连续部分。
2. **重复 ACK / 快速重传**：发送方连续收到对 seq=150 的重复 ACK 达到 3 个（`dupacks >= 3`）→ `tcp_rexmit_fast()` 立即重传，不等 RTO。
3. **对端半途消失**：数据重传超过 `TCP_MAXRTX` 或 SYN 超过 `TCP_MAXSYNRTX` → `tcp_abort`，向应用回调错误，回收 PCB。
4. **TIME-WAIT 中的旧报文**：`tcp_timewait_input()` 对不属于新连接的旧数据仅回 ACK，不进入握手，保证 2MSL 语义。

## 处理流程（lwIP 的 `tcp_*_handle` 路径）

lwIP 不把状态图集中在一个函数，而是沿三条路径实现：

- **收包主路径**（`src/core/tcp_in.c`）：`tcp_input()`（从 `pbuf` 解析 `tcp_hdr`、按四元组查 PCB、序列号检查）→ 按状态分派：
  - LISTEN → `tcp_listen_input()`（握手第二步）；
  - TIME-WAIT → `tcp_timewait_input()`（遗留报文最小应答）；
  - 其余 → `tcp_process()`（核心状态机：SYN/ACK/FIN/RST 处理）→ `tcp_receive()`（数据交付、窗口与 ACK 推进）。
- **发送路径**（`src/core/tcp_out.c`）：`tcp_output()` → `tcp_enqueue()`（切段入 `unsent`）→ `tcp_output_segment()`（受 `snd_wnd`/`cwnd` 约束取段、填选项、发往 IP）→ `tcp_rexmit_rto/fast`（重传）；ACK 推进由收包路径的 `tcp_free_acked_segments()` 触发。
- **定时路径**（`src/core/tcp.c`）：`tcp_tmr()` → `tcp_fasttmr()`（快速重传、keepalive、延迟 ACK 触发）与 `tcp_slowtmr()`（RTO 重传、拥塞窗口调整、FIN-WAIT-2 / TIME-WAIT 到期回收、SYN 重传上限）。

状态转移的「事实源」在 `tcp_process()` 与 `tcp_listen_input()` 中；文档状态图与实现一一对应，读到 `[STATE]` 注释时对照本文件定位。