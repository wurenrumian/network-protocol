# QUIC / HTTP/3 · protocol

## 问题定义

QUIC（RFC 9000）要在 UDP 之上提供 **可靠、有序、加密、可多路复用** 的字节流传输，同时消除 TCP+TLS+HTTP/2 时代累积的三类问题：

1. **连接建立延迟**：TCP 需要 1-RTT 建立连接，TLS 1.3 完整握手需要额外 1-RTT。QUIC 把握手与传输握手（transport parameters）合并进 TLS 1.3 握手，客户端首包（Initial）即携带加密握手数据；完整握手 1-RTT，带会话恢复时为 0-RTT（首包即可携带应用数据）。
2. **队头阻塞**：TCP 是单一字节流，一个丢包会让后续所有数据（哪怕属于 HTTP/2 的其他 stream）被 `in-order` 交付机制阻塞。QUIC 把可靠交付从"连接级单字节流"改为"stream 级"，stream 之间互不阻塞，消除传输层的队头阻塞。
3. **连接迁移**：TCP 以 4 元组标识连接，Wi-Fi↔蜂窝切换会断开连接。QUIC 用 Connection ID 标识连接，地址变化不影响连接本身，配合路径验证（PATH_CHALLENGE/PATH_RESPONSE）完成迁移。

QUIC 明确**不负责**：路由与寻址（交给 UDP/IP）、不保证应用层顺序（由 HTTP/3 流语义决定）、不提供消息语义（是字节流）。

## 抽象对象

- **Packet**：UDP datagram 内承载的最小单元，一个 datagram 可包含多个 packet。分 long header（Initial/0-RTT/Handshake/Retry/Version Negotiation）与 short header（1-RTT）两类。包内是加密的 payload，内含若干 frame。
- **Packet Number**：每个 packet number space 内单调递增的序号，用于 ACK、loss 检测与重传识别。因为连接加密后内容不可伪造，PN 不重复使用，也就无需 TCP 的序号模糊问题。quiche 中每个 space 由 `packet::PktNumSpace`（`packet.rs:856`）持有 `next_pkt_num`、`largest_rx_pkt_num`、`recv_pkt_need_ack`、`recv_pkt_num`（去重窗口）、`crypto_*`（加密密钥）与 `crypto_stream`（握手数据流）。
- **Packet Number Space**：三个 space——Initial、Handshake、Application(1-RTT/0-RTT)。每个 space 独立编号、独立密钥、独立 ACK。握手完成并丢弃对应密钥后 space 被清空（`drop_epoch_state`）。quiche 用 `Connection.pkt_num_spaces: [PktNumSpace; Epoch::count()]`（`lib.rs:1239`）表示。
- **Frame**：packet payload 中的最小信息单元，有 ACK、STREAM、CRYPTO、MAX_DATA、MAX_STREAM_DATA、RESET_STREAM、CONNECTION_CLOSE 等类型（见 wire format）。`frame::Frame::from_bytes` 解析，`Connection::process_frame` 分发。
- **Stream**：QUIC 的逻辑双向/单向字节流，用 64 位 stream ID 标识（低位 0/1 表示方向，bit 1 表示双向/单向）。每个 stream 独立可靠交付、独立流控，是消除传输层队头阻塞的关键。quiche 用 `stream::Stream`（`stream.rs:663`）表示，内部含 `recv`/`send` 两侧的 RangeBuf 队列与偏移量；`StreamMap` 持有所有 stream。
- **Connection**：一条 QUIC 连接 = 多个 packet number space + 多条路径 + TLS 会话 + stream 集合 + 流控与恢复状态。quiche 的 `Connection`（`lib.rs`）用 `recv`/`send`/`on_timeout` 三个方法驱动，状态查询走 `is_established`/`is_draining`/`is_closed`/`is_timed_out`。
- **Path**：一组本地/对端地址与当前 keys 的集合。连接迁移本质是换路径；quiche 的 `path.rs` 维护多路径（`paths`），迁移时做路径验证。
- **TLS 会话**：TLS 1.3 握手内嵌在 QUIC 中。quiche 的 `tls::Context`/`tls::Handshake`（`tls.rs`）封装 BoringSSL：握手数据通过 CRYPTO frame 交换，证书校验、会话恢复、early data（0-RTT）都由 BoringSSL 处理，QUIC 只负责把握手字节流映射到 CRYPTO 流并按 packet number space 区分密钥。`Connection.handshake` 字段类型即 `tls::Handshake`（`lib.rs:1249`），握手推进调用其 `do_handshake`（`tls.rs:630`）。
- **Flow Control**：连接级（MAX_DATA）与 stream 级（MAX_STREAM_DATA）两套信用额度。quiche 的 `flowcontrol::FlowControl`（`flowcontrol.rs:39`）维护 `consumed`/`max_data`/`window`/`max_window`，可 autotune 窗口。

## wire format

### 包结构（long header）

long header 包（Initial/0-RTT/Handshake/Retry/Version Negotiation）结构（RFC 9000 §17.2）：

```
 1  bit  First byte: Header Form(1)=1, Fixed Bit(1)=1, Long Packet Type(2), Type-Specific Bits(4)
 4  byte Version (32 bit)
 8+ byte DCID Length(8) + DCID
 8+ byte SCID Length(8) + SCID
 ...    Type-Specific Fields
 ...    Packet Number(1-4 byte, 截断) + Payload(加密)
```

- **Header Form**：最高位区分 long/short header。
- **Fixed Bit**：固定 1，用于区分非 QUIC 流量。
- **Version**：v1 = `0x00000001`（quiche `PROTOCOL_VERSION`）。Version Negotiation 包不含固定位。
- **DCID/SCID**：目的/源连接 ID。Retry 包 SCID 是被服务器更换后的 DCID。
- **Type-Specific Fields**：Initial 含 Token Length + Token（地址验证），Retry 含 Retry Token + Retry Integrity Tag，Handshake/0-RTT 无额外字段。
- **Packet Number**：1、2、3 或 4 字节，基于上一包解码出完整 PN（RFC 9000 A.3）。

quiche 中 `packet.rs` 的 `Header`、`Type`、`from_bytes`/`to_bytes` 实现该结构，`packet.rs` 顶部的 `Epoch` 把包类型映射到 packet number space。

### 包结构（short header）

```
 1  bit  First byte: Header Form(1)=0, Fixed Bit(1)=1, Spin Bit(1), Reserved(2), Key Phase(1), Packet Number Length(2)
 8+ byte DCID（当前短头使用）
 ...    Packet Number + Payload(加密)
```

short header 仅 1-RTT 包使用，不含版本与 SCID；Key Phase 位用于密钥更新（quiche `KeyUpdate`，`packet.rs:840`）。

### Frame 类型

packet payload 解密后是一串 frame（RFC 9000 §19）。quiche `frame.rs` 的 `Frame` 枚举（与 RFC 一一对应）：

| Frame | 作用 |
| --- | --- |
| `PADDING` / `PING` | 填充 / keep-alive，可触发对端 ACK |
| `ACK` | 携带 `ack_delay`、`ranges: RangeSet`（PN 范围）、可选 ECN 计数 |
| `RESET_STREAM` | 对端以 `final_size` 终止发送侧 |
| `STOP_SENDING` | 请求对端停止发送某 stream |
| `CRYPTO` | 传输 TLS 握手/密钥更新数据，带 offset（字节流） |
| `STREAM` | 应用数据，带 stream_id、offset、len、FIN 位 |
| `MAX_DATA` | 连接级流控上限提升 |
| `MAX_STREAM_DATA` | stream 级流控上限提升 |
| `MAX_STREAMS_BIDI/UNI` | 允许对端开更多流 |
| `DATA_BLOCKED` / `STREAM_DATA_BLOCKED` / `STREAMS_BLOCKED_*` | 告知对端本地流控受限，触发送 MAX_* |
| `NEW_CONNECTION_ID` / `RETIRE_CONNECTION_ID` | 连接迁移/多 CID 管理 |
| `PATH_CHALLENGE` / `PATH_RESPONSE` | 路径验证（8 字节随机数回显） |
| `CONNECTION_CLOSE` / `APPLICATION_CLOSE` | 传输级 / 应用级错误关闭 |
| `HANDSHAKE_DONE` | 服务器告知客户端握手完成 |
| `NEW_TOKEN` | 服务器签发 0-RTT/重连用的地址验证 token |
| `DATAGRAM` | QUIC datagram 扩展（quiche `dgram`，非 RFC 9000 核心） |

HTTP/3 层（`h3/`）在其上定义自己的帧：HEADERS（QPACK 编码）、DATA、SETTINGS、GOAWAY、MAX_PUSH_ID、CANCEL_PUSH、PUSH_PROMISE 等。

## 核心机制

### 握手与 TLS 集成

QUIC v1 用 TLS 1.3（RFC 9001），握手数据放在 **CRYPTO frame**（而非 TLS record 内的 QUIC 专用 record 类型 0x55494943）。关键点：

- Initial 密钥由初始 DCID 派生（quiche `packet.rs` 的 `initial_keys`/`decrypt_hdr`/`decrypt_pkt`），Handshake/1-RTT 密钥由 TLS 密钥调度派生，0-RTT 密钥由 early data secret 派生。
- 每次密钥安装都对应一个 packet number space；`Epoch`（Initial/Handshake/Application）即密钥阶段。`drop_epoch_state` 在收到对端丢弃某 space 的暗示（如收到 HandshakeDone、处理完 Initial）后清空密钥与状态。
- transport parameters（`max_idle_timeout`、`initial_max_data`、`initial_max_streams_*` 等）通过 TLS extension 交换，quiche 在 `lib.rs` 的 `encode_transport_params`/`parse_peer_transport_params`/`process_peer_transport_params` 处理，冲突时按 RFC 9000 §7.4 拒绝连接。
- 0-RTT：客户端用缓存密钥直接发应用数据（`is_in_early_data`），服务器在 validate token 后接受；服务器拒收时回 Version Negotiation/Retry 或丢弃 0-RTT 包，客户端退化到 1-RTT。quiche 支持 `enable_early_data`、`set_ticket_key`。

### ACK / loss 检测

- **ACK 语义**：`ACK` frame 的 `ranges` 是收到的 PN 区间集合，`ack_delay` 是接收方处理延迟。每个 packet number space 独立 ACK。
- **loss 检测**：基于 RFC 9002 的 PTO（Probe Timeout）+ 包阈值（PN gap ≥ 3）检测；丢包时把相关数据交给重传（`recovery::Recovery::on_ack_received`/`on_loss_detection_timeout` 返回 `lost_packets`，quiche 据此重新发送其 frame 数据）。
- **定时器**：`Recovery.loss_detection_timer`，超时进入 PTO，`on_pkt_num_space_discarded` 清理已丢弃 space 的检测状态。
- **ACK 触发策略**：收到需要 ACK 的包（ack-eliciting）后延迟合并 ACK（`max_ack_delay`），quiche `PktNumSpace.ack_elicited` 跟踪。

### 拥塞控制

RFC 9002 规定窗口式拥塞控制（cwnd），实现可替换。quiche `recovery/` 目录实现 Reno、CUBIC（`cubic.rs`）、BBR（`bbr/`）、PRR 降速（`prr.rs`）、Pacer（`pacer.rs`）、HyStart 启动探测（`hystart.rs`）、delivery rate 采样（`delivery_rate.rs`）。`Config::set_cc_algorithm` 选择算法；数据发送上限 = `min(cwnd_available, flow_control)`，`Recovery.cwnd`/`cwnd_available` 决定每次能发多少。

### 流与流控

- **Stream 生命周期**：创建（`get_or_create_stream`）→ 发送/接收 → 对端 FIN 或 RESET → 数据确认且读尽 → `collect`（释放）。QUIC stream 无 TCP 式半关闭握手，靠 FIN/RESET/STOP_SENDING 表达。
- **流控**：两级信用——连接级 `MAX_DATA`（总量）与 stream 级 `MAX_STREAM_DATA`（单流总量）。接收方按 `FlowControl` 的 `window` 发放额度，`should_update_max_data` 在可用额度低于窗口一半时申请 `max_data_next` 并发出 `MAX_DATA`；`autotune_window` 在 RTT×2 内有再次更新则窗口 ×1.5（上限 `max_window`）。发送方被 limit 挡住时发 `DATA_BLOCKED` 等帧通知对端。
- **stream 数限制**：`MAX_STREAMS_BIDI/UNI` 限制对端可开的流数上限，quiche `StreamMap.update_max_streams_*`。

### 连接迁移

- 连接用 DCID 而非 4 元组标识；两端各自维护可用的 source CID 集合（`NEW_CONNECTION_ID`/`RETIRE_CONNECTION_ID`）。
- 迁移时新路径先发 `PATH_CHALLENGE`，收到 `PATH_RESPONSE` 才确认路径可用（地址验证 + NAT 穿越）；quiche `path.rs` 的 `Path` 管理 keys 与 RTT，`migrate`/`on_peer_migrated`/`create_path_on_client` 完成切换。
- `disable_active_migration` 可由服务器声明（`Config::set_disable_active_migration`）。

### 0-RTT

TLS 1.3 early data + 服务器签发的 token（地址验证）：客户端 `enable_early_data`、`set_ticket_key`；首包 Initial 携带 token，随后 0-RTT packet 直接带应用数据。服务器 `is_in_early_data` 判断并决定接受/拒绝。

## 设计取舍

- **UDP 之上重造传输 vs 扩展 TCP**：TCP 改协议需更新内核与中间设备，且 4 元组迁移困难；QUIC 把全部逻辑放用户态（quiche 即证明），加密内建，连接迁移自由。代价：多一层 UDP 封装、实现复杂度高。
- **多路复用 vs TCP+N 连接**：QUIC 用 stream 复用一个连接，无 TCP 级队头阻塞；代价是 stream 级状态、独立流控与复杂度。
- **单包号 vs TCP 序号**：QUIC PN 单调递增、加密不可伪造，天然抗"旧包重放"，无需 TCP 的 SACK 协商与时间戳模糊（但需 `recv_pkt_num` 去重窗口）。
- **帧 vs TCP segment 语义**：frame 类型化让 ACK、流控、控制信息可分帧携带，避免 TCP 的 option 长度压力。
- **加密内建 vs 独立 TLS**：避免 TCP 的 cleartext 首包（可被中间设备干扰）、消除 TLS record 与 TCP segment 的边界错配。
- **HTTP/3 vs HTTP/2**：HTTP/2 的 stream 仍共享 TCP 字节流，一个丢包阻塞所有流；HTTP/3 每个请求/响应是一个 QUIC stream，真正隔离。
- **对照实现取舍**：ngtcp2（C）API 更贴近 RFC 结构；MsQuic 强调平台集成与 QUIC 卸载。quiche 选择 BoringSSL（而非 rustls）以复用 Cloudflare 的 TLS 基础设施。

## 不变量

- 每个 packet number space 内 PN 严格递增，发送方 `next_pkt_num` 单调。
- 同一 space 内 ACK 引用的 PN 必须已发送且未被丢弃；重传使用新 PN（QUIC 重发的是数据，不是同一 packet）。
- STREAM 数据按 offset 在接收侧重组；同一 offset 只交付一次；FIN 只出现一次且其 offset 即该 stream 发送侧终点。
- `MAX_DATA`/`MAX_STREAM_DATA` 单调不减；`consumed ≤ max_data`。
- stream ID 的方向性/单双性由 ID 编码固定，不得改变；同一 stream 的 RESET/STOP 后不可再发送数据。
- 每条路径的密钥、RTT、cwnd 独立；迁移后旧路径仍可收发（soft 迁移）。
- 0-RTT 数据只能在验证通过后交付；服务器拒绝 0-RTT 时不能把未经验证的数据当应用数据交付。

## 边界条件与异常处理

- **Stateless Reset**：收到无法解密且无法识别的包时用 stateless reset token 响应，让对方尽快终止（`is_stateless_reset`，`lib.rs:2179`）。
- **版本协商**：收到不支持的版本发 Version Negotiation 包；客户端回退重连（`negotiate_version`/`version_is_supported`）。
- **Retry 与地址验证**：服务器可发 Retry 更换 DCID 并附 token，防伪造源地址放大攻击；客户端重发 Initial 时携带 token（`quiche::retry`）。
- **握手失败/密钥不可用**：未解密包进入各自 space 的缓冲（`process_undecrypted_0rtt_packets`），密钥就绪后再处理；握手超时进入 PTO 最终 `is_timed_out`。
- **空闲超时与 draining**：`idle_timeout` 超时即关闭；收到 CONNECTION_CLOSE 后进入 draining 状态（相当于 TCP TIME-WAIT），期间丢弃新包但不回包，`draining_timer` 到期彻底清理。
- **流控越界**：收到超过 `MAX_DATA`/`MAX_STREAM_DATA` 的数据 → `FLOW_CONTROL_ERROR` 关闭；收到重复 FIN、超过 FIN 的 offset、RESET 后仍发数据 → `STREAM_STATE_ERROR`。
- **包号重复/乱序**：`recv_pkt_num`（`PktNumWindow`）去重，重复 PN 直接丢弃；老 PN 不会影响新状态。
- **流数越限**：超过 `MAX_STREAMS_*` 开新流 → `STREAM_LIMIT_ERROR`。
- **密钥更新**：Key Phase 翻转后旧密钥保留至 ACK 确认（`KeyUpdate` 记录 `pn_on_update`、`timer`），防重放与新旧密钥同时期错乱。
- **连接迁移中的 NAT 变化**：PATH_CHALLENGE 未确认前新路径不可承载应用数据；CID 被对端 retire 后不得再使用。