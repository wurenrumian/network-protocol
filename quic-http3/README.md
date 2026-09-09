# QUIC / HTTP/3

## 定位

本模块位于协议主干传输层之后、应用层之前：QUIC 是运行在 UDP 之上的可靠、有序、加密的传输协议，HTTP/3 是首个完全建立在 QUIC 之上的应用协议。它回答三组问题：

- 为什么在已有 TCP+TLS+HTTP/2 的情况下还要再造一个传输协议：连接建立延迟（0-RTT）、队头阻塞（TCP 头阻塞与 HTTP/2 的流级队头阻塞）、连接迁移、以及将安全内建到传输层。
- QUIC 如何把连接建立、握手、可靠性、流控、拥塞控制、多路复用、连接迁移压缩到一个由 UDP 承载的状态机中。
- quiche（Cloudflare 的 Rust 实现）如何把这些机制落成 `Connection`、`Stream`、`Recovery`、`PktNumSpace`、`FlowControl`、TLS 会话等对象以及 `recv`/`send`/`on_timeout` 的调用环。

QUIC 是不把任何机制放进内核的"用户态传输协议"，因此本模块源码完全来自用户态实现 quiche，不需要补内核代码。HTTP/3 的帧层与 QPACK 位于 `h3/` 子模块，作为应用层观察点；本模块的 `src/` 以 quiche 核心传输为主。

## 前置模块

- **UDP**：QUIC 的承载协议；理解端口、校验和、无连接语义，是读懂 QUIC packet 边界的前提。
- **TCP**：QUIC 大量机制是 TCP 的移植与再设计（可靠传输、ACK/loss、流控、拥塞控制、TIME-WAIT→draining），必须先掌握 TCP 的对应实现（lwIP）才能看出 QUIC 改了什么。
- **TLS**：QUIC v1 的握手复用 TLS 1.3（RFC 9001），密钥调度、证书、0-RTT 恢复均来自 TLS 1.3；本模块的 TLS 集成部分会引用 BoringSSL 的理解。
- **HTTP/2**（可选对照）：理解多路复用、流、HPACK 以及流级队头阻塞，才能对比 HTTP/3 的帧模型与 QPACK。

## 推荐阅读顺序

1. 读 `protocol.md`，建立问题定义与抽象对象（packet number、stream、connection、TLS 会话、flow control）。
2. 读 `state-machine.md`，掌握握手、stream 生命周期、loss 状态流转与 packet number space。
3. 进入 `src/README.md`，按"收包→解析→ACK→重传→发包"的闭环读源码。
4. 需要时对照 `references.md` 中的 RFC 章节与 ngtcp2/MsQuic 的实现取舍。
5. 有抓包条件时用 Wireshark 解出 QUIC 报文，与 `packet.rs` 的编码/解析对照，可补充 `observations.md`。

## 源码入口

- 源码导航：`src/README.md`（文件清单、类别、阅读顺序、调用链、入口/结束函数、未复制依赖）。
- 主实现：quiche（`github.com/cloudflare/quiche`），固定 tag `0.18.0`，对应 commit `28ef289f027713cb024e3171ccfa2972fc12a9e2`。
- 核心文件（位于 `src/upstream/quiche/src/`）：`lib.rs`（`Connection` 与收发包主循环）、`packet.rs`（packet 编解码与 `PktNumSpace`）、`stream.rs`、`flowcontrol.rs`、`recovery/`（ACK/loss/拥塞）、`tls.rs`（BoringSSL 集成）。
- 入口函数：`quiche::accept` / `quiche::connect`（创建连接）、`Connection::recv`（收包）、`Connection::send`（发包）、`Connection::on_timeout`（定时器）。
- 对照实现：ngtcp2、MsQuic（见 `references.md`）。

## 主实现 / 对照实现

主实现为 **quiche**（Rust，Cloudflare），范围覆盖 packet、ACK/loss、stream、flow control、TLS 集成与 HTTP/3（`h3/`）。对照实现为 **ngtcp2**（C，quiche 在注释中多处借鉴）与 **MsQuic**（微软，C，重点在 Windows 平台与内核卸载），用于比较连接迁移、路径验证与拥塞控制（Reno/CUBIC/BBR）的取舍。依据见 `protocol-learning-design.md` §4.0。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。上游源码保留相对路径复制到 `src/upstream/`，许可证与版权声明保留在 `src/LICENSES/`，未复制的依赖在 `src/README.md` 记录。