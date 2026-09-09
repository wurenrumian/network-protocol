# QUIC / HTTP/3 · state-machine

QUIC 没有单一"连接状态机"，而是**握手状态 + 三个 packet number space + 每条 stream + 每条路径**各自的推进规则，由 `Connection::recv`/`send`/`on_timeout` 共同驱动。以下分别描述。

## 状态

### 1. 连接建立（握手）状态

由 TLS 1.3 握手进度决定（quiche `handshake_status` → `recovery::HandshakeStatus`）：

| 状态 | 说明 |
| --- | --- |
| `Initial` | 仅 Initial 密钥可用；客户端发出 ClientHello（CRYPTO，Initial space） |
| `Handshake` | 收到 ServerHello，安装 Handshake 密钥；交换 ServerHandshake/ClientHandshake 数据 |
| `Application` | 安装 1-RTT 密钥，可收发应用数据；服务器另发 `HANDSHAKE_DONE` |
| `Established` | 两端应用密钥就绪（quiche `is_established`） |
| `EarlyData` | 客户端处于 0-RTT 窗口（`is_in_early_data`），可发未经验证的 0-RTT 数据 |
| `Draining` | 已收到/发出 CONNECTION_CLOSE，等待 `draining_timer` 到期，不回包 |
| `Closed / TimedOut` | 显式关闭或空闲/PTO 超时 |

### 2. Stream 状态

一个 QUIC stream 有发送侧与接收侧两个独立的推进（RFC 9000 §3.1）。quiche `stream::Stream` 用标志与队列表达：

- 发送侧：`Idle → Ready → Send → Data Sent（等 ACK）→ Data Recvd（对端 FIN 已确认或已 RESET）→ Reset Sent → Reset Recvd`。
- 接收侧：`Idle → Recv → Data Recvd（收到 FIN）→ Data Read（应用读尽）→ Reset Recvd → Reset Read`。
- 双向 stream 两侧重叠；单向 stream 只有一侧是本地所有权。
- 清理态：`is_complete`（双侧终结）后可 `collect` 释放；`is_draining` 表示已终结但数据未读尽。
- 异常态：`STOP_SENDING`/`RESET_STREAM` 提前终结一侧。

### 3. Recovery / Loss 状态

quiche `recovery::Recovery` 持有 per-path 的：`rtt`、`min_rtt`、`rttvar`、`cwnd`、`pto`、`loss_detection_timer`、`loss_probes`（PTO 探测计数）与各算法（Reno/CUBIC/BBR）内部状态。

- 发送阶段：`Slow Start（HyStart 探测） → Congestion Avoidance → （可选的 BBR 各阶段）`；PRR 在丢包时降速。
- 定时器状态：正常无 timer → 有 ack-eliciting 包时 `loss_detection_timer` 启动 → PTO 超时（发探测包，`loss_probes` 递增，PTO 按指数退避）→ 连续 PTO 达到上限触发 `is_timed_out`。

### 4. Packet Number Space 状态

每个 space（Initial/Handshake/Application）在 `packet::PktNumSpace` 中维护：`next_pkt_num`、`largest_rx_pkt_num`、`recv_pkt_need_ack`（RangeSet）、`recv_pkt_num`（去重窗口）、`crypto_open/crypto_seal` 与 `crypto_stream`（握手字节流）。

- 生命周期：**创建**（密钥安装）→ **活跃**（收发包、ACK）→ **丢弃**（`drop_epoch_state`：Initial/Handshake 密钥在对应阶段完成后清除，状态并入 recovery 处理 `on_pkt_num_space_discarded`）。

## 事件

| 事件 | 触发源 | 进入的推进 |
| --- | --- | --- |
| 客户端 `quiche::connect` / 服务器 `quiche::accept` | 应用层创建连接 | 生成初始 DCID/SCID、安装 Initial 密钥 |
| `Connection::recv(buf)` | 收到 UDP datagram | 解析 header → 定位 space → 解密 → 解析 frame → `process_frame` → 更新 ACK/loss/流控 → 排队发送 |
| `Connection::send(out)` | 应用层取包 | 取发送队列 → 应用 cwnd 与流控 → 构造 packet/frame → 加密 → 记录发送（`on_packet_sent`） |
| `Connection::on_timeout()` | 定时器到期 | 跑 loss 检测 / PTO / draining / idle timeout |
| `stream_send` / `stream_recv` / `stream_shutdown` | 应用层 I/O | 写入/读取 stream、置 FIN、发 RESET/STOP |
| `frame::Frame::from_bytes` 解析 | 收到各类 frame | 按帧类型更新对应状态（见状态转移） |
| `close(app, err, reason)` | 应用层错误/正常关闭 | 进入 draining，发 CONNECTION_CLOSE |

## 状态转移

### 握手（客户端视角，正常 1-RTT）

```
connect() 创建 Connection（Initial 密钥）
   → 发 Initial packet（CRYPTO: ClientHello）
   → recv 收到 Initial（ServerHello），安装 Handshake 密钥
   → 发 Handshake packet（CRYPTO: ClientFinished）
   → 收到 HandshakeDone，丢弃 Initial/Handshake 密钥（drop_epoch_state）
   → Established，可发 1-RTT 应用数据
```

服务器视角：`accept` 后收 ClientHello → 发 ServerHello + Handshake 数据 → 收 ClientFinished → 发 `HANDSHAKE_DONE` → Established。

### 0-RTT（会话恢复）

```
客户端：enable_early_data + set_ticket_key
   → connect 后直接发 0-RTT packet（EarlyData 态）
   → 服务器接受：EarlyData 密钥解密、token 验证，交付早期应用数据
   → 服务器拒绝：0-RTT 包无法解密/无 token，客户端退化到 1-RTT 重发
```

### Stream 生命周期（应用数据）

```
stream_send(id, data, fin) 创建 stream（Ready）
   → 数据进 send 队列，STREAM frame 随 send() 发出
   → 对端 ACK 该 PN → 数据从发送队列释放
   → 对端发 STREAM(fin) → 接收侧 Data Recvd
   → stream_recv 读尽 → 双侧终结 → collect 释放
```

异常路径：

```
对端 STREAM_DATA_BLOCKED → 本地发 MAX_STREAM_DATA（提升上限）
对端 STOP_SENDING → 本地停止发送并可能 RESET_STREAM（final_size 记录终点）
对端 RESET_STREAM(final_size) → 接收侧终结，丢弃 >= final_size 的数据
本地流控窗口不足 → 发 DATA_BLOCKED/STREAM_DATA_BLOCKED，等对端 MAX_DATA/MAX_STREAM_DATA
```

### Recovery / Loss 状态转移

```
发送 ack-eliciting 包 → 启动 loss_detection_timer（>= PTO）
收到 ACK（on_ack_received）：
   → 更新 rtt/min_rtt/rttvar/cwnd（ACK 确认的包从 ranges 移除）
   → 若 PN gap >= 3 判定丢包 → 标记 lost → 数据待重传 → PRR 降速
PTO 到期（on_loss_detection_timeout）：
   → 发 PTO 探测包（loss_probes++，指数退避）
   → 连续 PTO 超上限 → is_timed_out
收到对端丢弃 space 的暗示 → on_pkt_num_space_discarded 清理对应 space 的 loss 状态
```

### Packet Number Space 转移

```
Initial 密钥安装 → Initial space 活跃
   → 收到 ServerHello（Handshake 密钥安装）→ Handshake space 活跃
   → 1-RTT 密钥安装 → Application space 活跃
   → 各自在握手完成/对端已用新密钥后 drop_epoch_state 丢弃
   → 丢弃前将未确认的发送包数据转入重传，ACK 范围移交 recovery
```

### 连接关闭

```
close(app, err, reason) 或收到 CONNECTION_CLOSE/APPLICATION_CLOSE
   → Draining（draining_timer 启动，忽略新包，不回包）
   → 定时器到期 → 彻底释放
idle_timeout 到期 → TimedOut
```

## 正常 / 异常时序

### 正常：一次 HTTP/3 请求-响应

```
客户端 connect（Initial）→ 握手 1-RTT → Established
   → stream_send(0, HEADERS+QPACK, fin=false)  // HTTP/3 请求头
   → send() 发 STREAM frame
   → 服务器 stream_recv 读请求头 → stream_send(响应) → fin=true
   → 客户端读 DATA 直至 fin
   → 响应完成后 stream 终结并收集
```

### 异常：一个 STREAM 丢包

```
send() 发出 PNs 100-103（STREAM 数据 A 在 102）
   → 对端只 ACK 100、101、103
   → on_ack_received 发现 gap >= 3 → 102 判定 lost
   → 数据 A 标记重传 → 下一个 send() 用新 PN 104 重发
   → 对端重组，stream 交付顺序不受影响（其他 stream 不受牵连）
```

### 异常：服务器 0-RTT 拒绝

```
客户端发 0-RTT（EarlyData）
   → 服务器无对应 ticket 密钥 → 丢弃/回 RETRY 或 Normal 握手
   → 客户端 is_in_early_data=false → 重新完整握手后重发应用数据
```

### 异常：握手超时

```
客户端 Initial/Handshake 一直未收到对端应答
   → PTO 退避发探测包，直至上限 → is_timed_out()=true → 应用层关闭
```

## 处理流程（无显式状态机时）

quiche 没有集中式连接状态机文件，状态散落在 `Connection` 字段、`PktNumSpace`、`Stream`、`Recovery` 与 `path::Path` 中。完整闭环调用链（详见 `src/README.md`）：

```
收包入口：Connection::recv (lib.rs:2077)
   → recv_single (lib.rs:2216) 解析 Header / 定位 space / 解密
   → frame::Frame::from_bytes (frame.rs) 解析帧
   → Connection::process_frame (lib.rs:6595) 按帧更新状态
      → ACK → recovery.on_ack_received / loss 判定
      → STREAM → stream write + 流控记账
      → MAX_DATA/MAX_STREAM_DATA → 提升发送额度
      → PATH_CHALLENGE/RESPONSE → 路径验证
   → 排队发送
发包入口：Connection::send (lib.rs:3032) → send_single (lib.rs:3248)
   → 受 cwnd_available / 流控约束组帧 → encrypt → on_packet_sent → ACK 跟踪
定时器入口：Connection::on_timeout (lib.rs:5513)
   → recovery.on_loss_detection_timeout / PTO / draining / idle
流入口：Connection::stream_send/stream_recv (lib.rs:4540/4406)
   → stream::Stream::write/emit（stream.rs:1291/1356）
```

结束路径：`Connection::close`（进入 draining）→ `on_timeout` 的 draining timer 清理；或 `is_timed_out` 由应用层回收。