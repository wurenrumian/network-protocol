# QUIC / HTTP/3 · src

## 上游版本

- 仓库：`github.com/cloudflare/quiche`
- tag：`0.18.0`；tag 解析 commit：`28ef289f027713cb024e3171ccfa2972fc12a9e2`
- 许可证：BSD 2-Clause，见 `../LICENSES/COPYING`（上游根目录文件名即 `COPYING`）。
- 全部文件原样复制，未改动控制流；可在此基础上加学习注释。

## 文件清单（文件 → 类别 → 阅读范围）

所有文件按上游相对路径放在 `upstream/quiche/src/` 下。

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `lib.rs` | core/integration | 主入口：`Connection` 结构、`Config`、`accept`/`connect`/`retry`/`negotiate_version`；`recv`/`recv_single`/`process_frame` 收包主路径；`send`/`send_single` 发包主路径；`stream_*` 应用接口；`on_timeout` 定时器；transport parameters；`h3` 模块引用（`h3/` 未复制）。约 16000 行，跳过末尾测试与 `testing::` 辅助模块 |
| `packet.rs` | core | 包编解码：`Header`、`Type`、`Epoch`（packet number space 映射）、long/short header 解析、`decrypt_hdr`/`decrypt_pkt`/`encrypt_pkt`、Initial 密钥派生；`PktNumSpace`（`packet.rs:856`）定义与维护。跳过文件尾测试 |
| `stream.rs` | core | `Stream`/`StreamMap`：stream 状态、RangeBuf 重组、FIN/RESET/STOP 处理、`write`/`emit`（`stream.rs:1291/1356`）。跳过尾部大量单测 |
| `flowcontrol.rs` | core | `FlowControl`：连接级信用、窗口 autotune、`MAX_DATA` 计算（`flowcontrol.rs:39`） |
| `recovery/mod.rs` | core | RFC 9002：`Recovery` 结构、`on_packet_sent`/`on_ack_received`（`recovery/mod.rs:430`）/`on_loss_detection_timeout`（`:600`）、cwnd/rtt/pto、`HandshakeStatus` |
| `recovery/cubic.rs` | core | CUBIC 拥塞控制实现（`on_ack`/`on_loss`） |
| `recovery/reno.rs` | core | Reno 拥塞控制实现 |
| `recovery/prr.rs` | core | PRR（Proportional Rate Reduction）丢包降速 |
| `recovery/pacer.rs` | core | 令牌桶 pacing，控制发包间隔 |
| `recovery/delivery_rate.rs` | core | delivery rate 采样（供 BBR/应用估计） |
| `recovery/hystart.rs` | core | HyStart 慢启动探测 |
| `tls.rs` | integration | BoringSSL 集成：`tls::Context`/`Handshake`、`do_handshake`（`tls.rs:630`，`Handshake` 的方法）、密钥安装、transport params 的 TLS extension、early data |
| `LICENSES/COPYING` | — | 上游根 LICENSE（BSD 2-Clause），复制到 `../LICENSES/COPYING` |

未复制但作为依赖出现的文件（见"未复制的依赖"）：`frame.rs`、`path.rs`、`crypto.rs`、`ranges.rs`、`cid.rs`、`minmax.rs`、`rand.rs`、`dgram.rs`、`h3/*`、`ffi.rs`、`build.rs`。

## 阅读顺序与调用链

按三条闭环读，先 core 后 integration：

**闭环 1 · 收包（输入主路径）**
```
Connection::recv (lib.rs:2077)
 → recv_single (lib.rs:2216)：Header 解析（packet.rs）、定位 space、decrypt_pkt（packet.rs:651）
 → frame::Frame::from_bytes (frame.rs:183，未复制，参考 RFC 9000 §19 与 enum)
 → Connection::process_frame (lib.rs:6595)：
    · ACK → recovery.on_ack_received → loss 判定/重传入队（recovery/mod.rs:430）
    · STREAM → stream.rs write + 流控记账
    · CRYPTO → tls.rs do_handshake / crypto_stream 推进
    · MAX_DATA/MAX_STREAM_DATA → 提升发送额度（flowcontrol.rs）
    · PATH_CHALLENGE/RESPONSE → 路径验证
 → 排队待发
```

**闭环 2 · 发包（输出主路径）**
```
Connection::send (lib.rs:3032) → send_on_path → send_single (lib.rs:3248)
 → 受 cwnd_available（recovery/mod.rs:705）与流控余额约束
 → 组 STREAM/ACK/MAX_DATA 等 frame（lib.rs:3520 起）
 → encrypt_pkt → 写 out
 → recovery.on_packet_sent（recovery/mod.rs:328）记录 PN 与 ACK 跟踪
```

**闭环 3 · 定时器**
```
Connection::on_timeout (lib.rs:5513)
 → recovery.on_loss_detection_timeout (recovery/mod.rs:600) → PTO 探测/loss
 → draining_timer 到期 → 释放连接
```

**闭环 4 · 应用流 I/O（integration 边界）**
```
Connection::stream_send/stream_recv (lib.rs:4540/4406)
 → stream::Stream::write/emit (stream.rs:1291/1356) → 数据进发送队列/应用读缓冲
```

**闭环 5 · 握手（integration）**
```
connect/accept → do_handshake (lib.rs:6397) → tls::Handshake::do_handshake (tls.rs:630)
 → CRYPTO frame 交换 → drop_epoch_state（密钥 space 丢弃）
```

## 入口函数 / 结束函数

入口（按读取顺序）：

- `quiche::accept(scid, odcid, local, peer, config)` — `lib.rs:1443`，服务器创建连接。
- `quiche::connect(server_name, scid, local, peer, config)` — `lib.rs:1471`，客户端创建连接并设 SNI。
- `Connection::recv(&mut self, buf, info) -> Result<usize>` — `lib.rs:2077`，收包入口。
- `Connection::send(&mut self, out) -> Result<(usize, SendInfo)>` — `lib.rs:3032`，发包出口。
- `Connection::on_timeout(&mut self)` — `lib.rs:5513`，定时器入口。
- `Connection::stream_send(stream_id, buf, fin)` — `lib.rs:4540`；`Connection::stream_recv(stream_id, out)` — `lib.rs:4406`。
- `Connection::close(app, err, reason)` — `lib.rs:5995`。

结束函数（状态查询/关闭）：

- `Connection::close` → 进入 draining；draining_timer 到期在 `on_timeout` 中清理（`lib.rs:5995`、`lib.rs:5513`）。
- `Connection::is_draining()` — `lib.rs:6188`；`is_closed()` — `lib.rs:6196`；`is_timed_out()` — `lib.rs:6202`。
- 每个 space 的丢弃出口：`Connection::drop_epoch_state(epoch, now)` — `lib.rs:7055`。

## 未复制的依赖

复制自上游 `quiche/src/`，以下模块未复制但被上述文件引用，阅读时按需回上游仓库查看：

| 模块 | 用途 |
| --- | --- |
| `frame.rs` | `Frame` 枚举与编解码（本仓库只引用其枚举形状做 wire format 对照） |
| `path.rs` | `Path`/`Paths`：每路径 Recovery、迁移、CID 管理 |
| `crypto.rs` | AEAD（ring）封装、密钥派生、`Open`/`Seal` 类型 |
| `ranges.rs` | `RangeSet`：ACK 区间、接收去重窗口 `PktNumWindow` |
| `cid.rs` | Connection ID 解析与生成 |
| `minmax.rs` | cwnd 追踪的 min/max 滑动窗口 |
| `rand.rs` | 随机数（用于 PathChallenge 等） |
| `dgram.rs` | DATAGRAM 扩展 |
| `h3/` | HTTP/3 帧与 QPACK（学习 HTTP/3 帧层时再复制） |
| `ffi.rs` | C FFI（非学习路径） |
| `build.rs`、`bbr/` | 构建脚本；BBR 拥塞（本仓库未复制，`recovery/mod.rs` 会引用） |

其他外部依赖：`ring`（AEAD/哈希）、`BoringSSL`（TLS）、`log`/`qlog`（日志）、`libc`（FFI）、`socket2`（示例）。这些由 Cargo.toml 管理，不复制。

## 已复制 / 跳过说明

- **已复制**：上面清单中的 12 个 Rust 源文件 + `LICENSES/COPYING`，共 13 个文件。
- **原计划路径修正**：`recovery.rs` 在 0.18.0 实为目录 `recovery/`（取 `mod.rs` + 7 个算法文件）；`flow_control.rs` 实为 `flowcontrol.rs`；`space.rs` 不存在，packet number space 定义在 `packet.rs::PktNumSpace`。已在 `references.md` 记录。
- **跳过**：`h3/`、`bbr/`、`frame.rs`、`path.rs`、`crypto.rs`、`ranges.rs`、`cid.rs`、`minmax.rs`、`rand.rs`、`dgram.rs`、`ffi.rs`、`build.rs`、Cargo.toml 与示例。原因：与当前闭环（packet/ACK/loss/stream/flow control/TLS 集成）无关或不属于学习路径，相关依赖关系已记录。