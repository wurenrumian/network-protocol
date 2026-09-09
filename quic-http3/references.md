# QUIC / HTTP/3 · references

## 规范 / 标准

- **RFC 9000** — QUIC: A UDP-Based Multiplexed and Secure Transport。核心规范：packet 格式（§17-18）、frame（§19）、stream 与流控（§3-4）、连接迁移（§9）、错误处理（§10）。
- **RFC 9001** — Using TLS to Secure QUIC。TLS 1.3 与 QUIC 的集成：密钥派生、Initial 密钥、transport parameters 的 TLS extension、0-RTT、密钥更新。
- **RFC 9002** — QUIC Loss Detection and Congestion Control。ACK、RTT 估算、PTO、丢包判定（包阈值/时间阈值）、cwnd 调整。
- **RFC 9114** — HTTP/3。HTTP 语义映射到 QUIC stream、帧格式（HEADERS/DATA/SETTINGS/GOAWAY）、错误码。quiche `h3/` 模块实现。
- **RFC 9204** — QPACK: Field Compression for HTTP/3。HPACK 的 QUIC 适配（避免跨 stream 队头阻塞），含静态/动态表。quiche `h3/qpack/` 实现。
- **RFC 9221** — An Unreliable Datagram Extension to QUIC（可选）。DATAGRAM frame；quiche `dgram` 模块已实现。
- **IETF QUIC Working Group drafts**：v1 之前版本（draft-29 等）作为演化背景，quiche 曾支持多版本协商。

## 论文

- **QUIC: A UDP-Based Multiplexed and Secure Transport**（IETF 草案体系，无单篇论文；机制背景见 Google 原始 QUIC 论文）。
- **Taking a Long Look at QUIC**（Kuhn et al., 2020）— 对早期 QUIC 部署的现象观察，解释协议设计动机。
- **HTTP/3 与 QPACK**：RFC 9204 参考文献；QPACK 的设计目标是消除 HTTP/2 的 HPACK 队头阻塞。
- **BBR: Congestion-Based Congestion Control**（Cardwell et al., 2016）— quiche `recovery/bbr/` 的实现依据。
- **CUBIC: A New TCP-Friendly High-Speed TCP Variant**（Ha et al., 2008）— quiche `recovery/cubic.rs` 的实现依据。

## 上游仓库（固定版本 / commit）

- **主实现：quiche** — `github.com/cloudflare/quiche`
  - 固定 tag：`0.18.0`（`git ls-remote` 确认存在）
  - tag 解析到的 commit：`28ef289f027713cb024e3171ccfa2972fc12a9e2`
  - 本模块复制文件及其上游路径见 `src/README.md`。
  - 许可证：BSD 2-Clause（见 `src/LICENSES/COPYING`，上游文件名即 `COPYING`，非 `LICENSE`）。
  - 上游文件布局注意：`quiche/src/` 下 `recovery.rs` 实际是**目录** `recovery/`（mod.rs + cubic.rs/reno.rs/prr.rs/pacer.rs/delivery_rate.rs/hystart.rs + bbr/ 子目录）；流控文件名是 `flowcontrol.rs`（无下划线）；**没有** `space.rs`，packet number space 定义在 `packet.rs` 的 `PktNumSpace`，实例挂在 `lib.rs` 的 `Connection.pkt_num_spaces`。本任务原计划的 `recovery.rs`/`flow_control.rs`/`space.rs` 路径按实际文件修正。

## 其他实现

- **ngtcp2** — `github.com/ngtcp2/ngtcp2`（C）。quiche 注释中明确引用其思路；API 结构更贴近 RFC 章节，适合对照"同一个 RFC 的不同落法"。
- **MsQuic** — `github.com/microsoft/msquic`（C）。侧重 Windows 平台与硬件/内核卸载，连接迁移与路径管理实现与 quiche 差异明显，适合对照平台集成。
- **quinn** — `github.com/quinn-rs/quinn`（Rust，基于 rustls）。若想对照"不依赖 BoringSSL、纯 rustls"的 TLS 集成方式可参考（quiche 选 BoringSSL 是 Cloudflare 内部基础设施的延续）。
- **picoquic / lsquic**：轻量实现，可作编解码对照。

## 阅读备注

- 以 **RFC 9000 §17-19（wire）+ §3-4（stream/流控）+ RFC 9002（loss/拥塞）** 为主线，再回 quiche 落点。
- quiche 的 `Connection` 是巨型结构（`lib.rs` 数千行），不要通读；按 `recv → process_frame → 状态更新`、`send → 组帧加密`、`on_timeout → loss/PTO` 三条链读。
- `packet.rs` 顶部 `Epoch` 枚举是理解三个 packet number space 的钥匙；`PktNumSpace`（`packet.rs:856`）把密钥、PN、ACK 跟踪、握手流收在一个对象里。
- `recovery/mod.rs` 是 RFC 9002 的忠实实现；`Recovery` 挂在 `path::Path` 上（per-path），注意"每条路径一个 Recovery"。
- 0-RTT 与 `PktNumSpace` 的 `crypto_0rtt_open/seal`、`is_in_early_data`、`process_undecrypted_0rtt_packets` 连起来读。
- 本模块保留 quiche 核心传输文件，**未**复制 `h3/`（HTTP/3 帧与 QPACK）、`frame.rs`（仅列出枚举用于 wire format 对照）、`path.rs`/`crypto.rs`/`ranges.rs` 等依赖模块——学习 HTTP/3 帧层时再按需补 `h3/`。
- 复制进来的文件均未改动，仅可加学习注释；确需修正时才按 §6 出补丁文件并在本文件说明。