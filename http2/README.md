# HTTP/2

## 定位

本模块在协议主干中位于 HTTP/1.1 之后、QUIC/HTTP/3 之前，负责解决 HTTP/1.1 的队头阻塞与多路复用问题。核心关注四个机制：

- **frame**：二进制帧的解析与构造（帧头、帧类型、长度、流 ID）；
- **stream**：流状态机与流生命周期管理；
- **HPACK**：头部压缩（静态表 + 动态表 + Huffman 编码）；
- **flow control**：连接级与流级滑动窗口。

主实现为 **nghttp2**（lib 库，非 nghttpx 应用），对照实现为 nginx HTTP/2 模块与 h2o。阅读时以「收到一帧 → 更新流/窗口状态 → 产生输出」的闭环为主干。

## 前置模块

按学习顺序依赖以下已读模块：

- **TCP**：帧在 TCP 连接上按序可靠传输，HTTP/2 不再自行处理重传与拥塞（沿用 TCP 语义），理解队头阻塞需先理解 TCP 的字节流模型；
- **TLS**：h2 明文升级用 `Upgrade: h2c`，ALPN 协商（`h2`/`http/1.1`）发生在 TLS 握手扩展中，nghttp2 的调用方通过 TLS 库告知协商结果；
- **HTTP/1.1**：作为对照对象——HTTP/1.1 的 keepalive/pipelining 为什么不够，以及头部重复传输的开销，是理解 HTTP/2 设计动机的直接背景。

## 推荐阅读顺序

1. 先读 `protocol.md` 与 RFC 7540 §3–§6，建立 frame/stream/HPACK/流控的抽象；
2. 再读 `state-machine.md`，对照 RFC 7540 §5.1 的流状态图与 nghttp2 内部状态；
3. 进入 `src/README.md`，按调用链读源码：`session_recv` → 帧解析 → 流状态推进 → 窗口更新 → `session_send`；
4. HPACK 单独闭环：`hd_inflate_hd` / `hd_deflate_hd`，对照 RFC 7541 §4 动态表；
5. 最后对照 nginx HTTP/2 模块或 h2o，比较流控与优先级实现取舍。

## 源码入口

详见 `src/README.md`。核心入口：

- `src/upstream/lib/nghttp2_session.c`：`nghttp2_session_recv()` / `nghttp2_session_send()`，会话主循环；
- `src/upstream/lib/nghttp2_frame.c`：`nghttp2_frame_unpack_frame_hd()` / `nghttp2_frame_pack_frame_hd()`；
- `src/upstream/lib/nghttp2_hd.c`：`nghttp2_hd_inflate_hd()` / `nghttp2_hd_deflate_hd()`；
- `src/upstream/lib/nghttp2_stream.c`：`nghttp2_stream_init()` / `nghttp2_stream_shutdown()`，优先级队列。

## 主实现 / 对照实现

| 角色 | 实现 | 说明 |
| --- | --- | --- |
| 主实现 | **nghttp2**（`github.com/nghttp2/nghttp2`，tag `v1.58.0`） | 完整独立的 HTTP/2 库，frame/stream/HPACK/流控齐备，源码可独立阅读 |
| 对照 | **nginx**（ngx_http_v2_module） | 嵌入式 HTTP/2 模块，观察与事件循环/内存池的集成方式 |
| 对照 | **h2o** | 强调低延迟与头压缩性能的独立实现，可比较优先级与窗口策略 |

## 目录规范

参见根目录 `protocol-learning-design.md` §3。上游源码与许可证保留在 `src/upstream/` 与 `src/LICENSES/`，本模块不在源码上做控制流改动，学习注释直接写在副本上。