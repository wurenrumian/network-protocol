# HTTP/1.1

## 定位

本模块以 HTTP/1.1 为研究对象，回答「一个无状态文本协议如何在长时间存活、复用的 TCP 连接上被高效地解析与处理」。HTTP/1.1 是 Web 协议树的根基：它的请求行 + 头 + body 三件套、keepalive 复用、chunked 分块和 content-length 定界，是 HTTP/2（帧 + 流 + HPACK）与 QUIC/HTTP/3 的上层语义来源。本模块在阅读序列中位于 TLS 之后、HTTP/2 之前。

核心问题：

- 如何把字节流切分成「请求/响应」单元（message framing，RFC 9112 §6）；
- 一个连接上的多个请求如何有序复用（keepalive），复用失败时如何退化为逐连接一个请求（HTTP/1.0 行为）；
- 消息 body 在四种定界方式（content-length、chunked、无 body、关闭连接）下如何被一致地识别；
- 一个长连接在什么条件下可以回收给连接池、什么条件下必须关闭。

本模块不负责：URI 语义、缓存、代理语义、TLS 本身、HTTP/2 之后的帧/流模型——这些是后续或旁支模块的内容。

## 前置模块

| 模块 | 依赖内容 |
| --- | --- |
| 协议抽象与编码 | 报文布局、字节序、长度/边界、状态机、错误模型 |
| TCP | 字节流、连接关闭语义（FIN 与 RST 的差异）、半关闭、TIME-WAIT、MSL——keepalive 与 lingering close 依赖这些语义 |
| TLS | 一个连接上字节流被 TLS record 分界后的到达方式（TCP → TLS → HTTP） |

## 推荐阅读顺序

1. 先读本模块 `protocol.md` 的问题定义与 wire format，建立「消息 = start line + 头 + body」的模型。
2. 读 `state-machine.md`，理解 nginx 请求解析的三阶段状态机与 keepalive 生命周期。
3. 进入 `src/README.md`，按调用链读源码：request line 解析 → header 解析 → body 处理 → 响应输出 → 连接回收。
4. 对照 `references.md` 中的 RFC 9110/9112 相关章节，核对源码实现与规范术语（如 `tokens`、`obs-fold`、`connection: close`）。
5. 可选：用 curl/llhttp 作为对照实现，比较解析器设计与错误处理取舍。

## 源码入口

- 请求解析与处理状态机：`src/upstream/src/http/ngx_http_request.c`
- HTTP parser（纯解析，无 I/O）：`src/upstream/src/http/ngx_http_parse.c`
- 核心处理流程（handler 调度、输出）：`src/upstream/src/http/ngx_http_core_module.c`；keepalive 判定与连接关闭在 `src/upstream/src/http/ngx_http_request.c`（`ngx_http_set_keepalive`、`ngx_http_close_connection`）
- 响应输出与 chunked 编码：`src/upstream/src/http/ngx_http_copy_filter_module.c`
- 响应头序列化：`src/upstream/src/http/ngx_http_header_filter_module.c`

入口函数：事件循环在可读事件上调 `ngx_http_process_request_line`（`ngx_http_request.c:1083`）。调用链细节见 `src/README.md`。

## 主实现 / 对照实现

| 角色 | 实现 | 用途 |
| --- | --- | --- |
| 主实现 | nginx（release-1.25.3，commit `b8fb83b8d2e7ca03d43176b767f1fc657f1c1ee2`） | 完整的请求/响应闭环：解析、处理、输出、keepalive、chunked |
| 对照实现 | curl（客户端解析）、llhttp（独立 HTTP parser） | 比较解析策略与错误处理取舍 |

选型依据见根目录 `protocol-learning-design.md` §4.0 / §4.5。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。源码按 `core/`（解析、状态机）、`integration/`（连接回收、事件驱动）、`platform/`（缓冲区、socket 抽象）分类，清单见 `src/README.md`。