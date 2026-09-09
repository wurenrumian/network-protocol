# HTTP/2 · references

## 规范 / 标准

| 文档 | 内容 | 在本模块中的用途 |
| --- | --- | --- |
| **RFC 7540** — Hypertext Transfer Protocol Version 2 (HTTP/2) | 连接语义、帧格式（§6）、流状态机（§5.1）、流优先级（§5.3）、流控（§6.9）、SETTINGS/GOAWAY（§6.4–§6.8） | protocol.md 与 state-machine.md 的规范依据 |
| **RFC 7541** — HPACK: Header Compression for HTTP/2 | 静态表（§A）、动态表（§4）、前缀整数编码（§5）、编码类型（§6） | HPACK 编解码章节依据 |
| **RFC 9113** — HTTP/2（取代 RFC 7540 的修订版） | 对 7540 的勘误与澄清 | 版本差异核对；本模块以 7540 为主，必要时对照 9113 |
| **RFC 9218** — Extensible Prioritization Scheme for HTTP | 新优先级方案（`:pri` 字段、`SETTINGS_PRIORITY_UPDATE`） | 理解 nghttp2 `lib/nghttp2_extpri.c` 的背景 |
| **RFC 7540 弃用说明 / RFC 9114** — HTTP/3 | 说明 HTTP/2 的 TCP 队头阻塞问题如何被 QUIC 解决 | 对照阅读（HTTP/3 模块前置） |
| **draft-ietf-httpbis-cache** | PUSH_PROMISE 与缓存的交互 | 服务器推送的设计讨论（可选） |

## 论文

- 队头阻塞与多路复用的量化分析常见于 QUIC 相关论文（如 Google 的 QUIC 设计描述），可先读 blog 级资料建立动机，再对照 HTTP/2 帧/流设计。
- HPACK 的 Huffman 编码设计可对照 **RFC 7541 §B** 的 Huffman 码表与 `nghttp2_hd_huffman.c`（本模块未复制，见 src/README.md）。

## 上游仓库（固定版本 / commit）

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/nghttp2/nghttp2 |
| 固定 tag | **v1.58.0** |
| tag 对应 commit | `48dc8e70f003473c198273750f0217dfbe22db9f` |
| 使用对象 | lib 库（`lib/` 目录），非 nghttpx 应用 |
| 许可证 | MIT（`COPYING`，已复制到 `src/LICENSES/COPYING`） |

源码下载自 `https://raw.githubusercontent.com/nghttp2/nghttp2/v1.58.0/<path>`，仅保留与 frame/stream/HPACK/流控闭环相关的文件，未做任何控制流改动；学习注释直接写在 `src/upstream/` 的副本上。

## 其他实现

| 实现 | 特点 | 对比角度 |
| --- | --- | --- |
| **nginx**（`ngx_http_v2_module`） | 嵌入式模块，与事件循环、内存池、upstream 集成 | 流优先级简化、窗口管理与内存控制策略 |
| **h2o** | 独立服务器，强调低延迟与 hpack 性能 | 头部压缩与静态表/动态表预热的取舍 |
| **quiche / ngtcp2**（HTTP/3） | 帧/流模型迁移到 QUIC，HPACK 换成 QPACK | 对照有状态压缩 vs 流级独立压缩（HTTP/3 模块） |

## 阅读备注

1. nghttp2 中**没有独立的 `nghttp2_flow.c`**：v1.58.0 的流控逻辑全部位于 `nghttp2_session.c`（窗口字段、`nghttp2_session_enforce_flow_control_limits()`、`session_update_*_consumed_size()` 等）。已复制的 `nghttp2_session.c` 同时承担会话、流状态机与流控职责。
2. `nghttp2_flow.h` 在 v1.58.0 中同样不存在（曾存在于更早版本，后并入 `nghttp2_session.c` 与 `nghttp2_local_window` 相关文件），因此任务清单中的 `lib/nghttp2_flow.c` 无法下载，已在 `src/README.md` 注明并以下方式覆盖：流控闭环在 `nghttp2_session.c` 内完成。
3. 帧类型与窗口/流状态的常量定义在 `lib/nghttp2_hd.h`、`lib/nghttp2_stream.h`、`lib/nghttp2_session.h`、`lib/nghttp2_frame.h`；本模块只复制了 `nghttp2_hd.h`，其余头文件在 `src/README.md` 的未复制依赖中列出。
4. 头块大帧需要 CONTINUATION 帧拆分；nghttp2 的 `nghttp2_hd_inflate_end_headers()` 在头块边界校验完整性。
5. 动态表容量变更指令（RFC 7541 §6.3）由 `nghttp2_hd_*_change_table_size()` 对应处理，是 COMPRESSION_ERROR 的主要来源之一。
6. 观察工具：`nghttp`（nghttp2 自带 CLI）、Wireshark 的 HTTP/2 解码器、`curl --http2`，可与 `observations.md` 流程配合。