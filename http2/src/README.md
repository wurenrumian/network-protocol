# HTTP/2 · src

## 上游版本

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/nghttp2/nghttp2 |
| tag | **v1.58.0**（commit `48dc8e70f003473c198273750f0217dfbe22db9f`） |
| 许可证 | MIT，见 `../LICENSES/COPYING` |
| 使用对象 | lib 库（`lib/` 目录） |

所有文件直接从 `https://raw.githubusercontent.com/nghttp2/nghttp2/v1.58.0/<path>` 下载，保留原始相对路径，未修改任何控制流。学习注释直接写在副本上。

## 文件清单（文件 → 类别 → 阅读范围）

复制进 `upstream/lib/` 的文件（共 5 个）：

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `lib/nghttp2_session.c` | **core** | 会话主循环（`nghttp2_session_recv`/`_send`）、帧接收分派、流状态推进、流控窗口维护、terminate/GOAWAY 路径 |
| `lib/nghttp2_frame.c` | **core** | 9 字节帧头打包/解包、各帧类型 payload 构造（`nghttp2_frame_pack_*` / `nghttp2_frame_unpack_*`） |
| `lib/nghttp2_hd.c` | **core** | HPACK 编码（`nghttp2_hd_deflate_*`）与解码（`nghttp2_hd_inflate_*`）、动态表维护 |
| `lib/nghttp2_stream.c` | **core** | 流对象初始化/释放、方向关闭（`nghttp2_stream_shutdown`）、优先级依赖队列（`stream_obq_*`） |
| `lib/nghttp2_hd.h` | **core** | HPACK 编解码器结构与动态表相关声明 |

补充说明：

- 流控不单列文件：v1.58.0 **不存在** `lib/nghttp2_flow.c`（任务清单中的路径），流控逻辑整体位于 `nghttp2_session.c`；`lib/nghttp2_flow.h` 在该 tag 下同样不存在（404），因此未复制。
- 任务清单中「lib/nghttp2_flow.c」一行以本段说明替代，未伪造内容。

## 阅读顺序与调用链

先读 `core/` 文件，按以下两条闭环组织；`integration/`、`platform/` 相关依赖未复制（见下节），仅在需要时联查。

### 接收闭环（帧进来 → 状态推进 → 交付/回补）

```text
nghttp2_session_recv()                       [nghttp2_session.c:7297]
→ nghttp2_session_mem_recv()
→ 逐帧：帧头解包 nghttp2_frame_unpack_frame_hd()      [nghttp2_frame.c:45]
→ 按类型分派 nghttp2_session_on_frame_received()
   ├─ HEADERS → 流状态推进 / HPACK 解码 nghttp2_hd_inflate_hd()  [nghttp2_hd.c:1836]
   ├─ DATA   → 窗口递减 / 交付回调
   ├─ WINDOW_UPDATE → 窗口增量，唤醒阻塞发送
   ├─ RST_STREAM → 单流关闭 nghttp2_session_close_stream()      [nghttp2_session.c:1457]
   └─ 致命错误 → nghttp2_session_terminate_session()             [nghttp2_session.c:254]
→ 消费数据后回补窗口 nghttp2_session_consume()
```

### 发送闭环（选流 → 限额 → 打包 → 出队列）

```text
nghttp2_session_send()                       [nghttp2_session.c:3538]
→ nghttp2_session_mem_send_internal()
→ 优先级队列选流（nghttp2_stream.c 的 stream_obq_*）
→ 流控限额 nghttp2_session_enforce_flow_control_limits()  [nghttp2_session.c:2107]
→ 构造帧 nghttp2_frame_pack_frame_hd()       [nghttp2_frame.c:37] / 各 pack_*
→ 窗口递减 → 回调写 socket
```

### HPACK 闭环

```text
编码: nghttp2_hd_deflate_hd()                [nghttp2_hd.c:1491]
解码: nghttp2_hd_inflate_hd() / _hd2()       [nghttp2_hd.c:1836/1843]
头块结束: nghttp2_hd_inflate_end_headers()   [nghttp2_hd.c:2238]
表容量变更: nghttp2_hd_deflate_change_table_size()   [nghttp2_hd.c:1245]
           nghttp2_hd_inflate_change_table_size()    [nghttp2_hd.c:1261]
```

## 入口函数 / 结束函数

| 方向 | 入口 | 结束 |
| --- | --- | --- |
| 接收 | `nghttp2_session_recv()`（应用调用） | 应用回调交付完成；窗口回补由 `nghttp2_session_consume()` 结束 |
| 发送 | `nghttp2_session_send()`（应用调用） | 帧打包回调写 socket 完成；连接终止以 `nghttp2_session_terminate_session()` 为结束入口 |
| 会话创建/销毁 | `nghttp2_session_client_new()` / `server_new()`（在 `nghttp2_session.c` 中，由 `nghttp2_session_new` 统一调用） | `session_del()` 释放全部流与表资源 |
| HPACK 编码器/解码器 | `nghttp2_hd_deflate_new()` / `nghttp2_hd_inflate_new()` | `nghttp2_hd_*_end()` 释放 |
| 流对象 | `nghttp2_stream_init()`（`nghttp2_stream.c`） | `nghttp2_stream_free()` |

注：会话构造/销毁函数与 `nghttp2_session.h` 的头文件声明未被复制（见下节），入口函数名以 `nghttp2_session.c` 内实际定义为准。

## 未复制的依赖

本模块只复制了闭环内的 5 个 `lib/` 文件；`src/upstream/` 之外仍被这些文件 #include 的头文件与模块未复制，阅读时若遇到符号缺失，按下列依赖查上游仓库：

| 依赖 | 说明 |
| --- | --- |
| `lib/nghttp2_session.h`、`lib/nghttp2_frame.h`、`lib/nghttp2_stream.h`、`lib/nghttp2_priority_spec.h` 等 | 各对象结构定义与公共 API 声明（常量枚举、`nghttp2_stream_state`、帧类型等），阅读 `*.c` 时需对照 |
| `lib/nghttp2_int.h`、`lib/nghttp2_mem.h`、`lib/nghttp2_buffer.h` | 内存分配与内部通用结构 |
| `lib/nghttp2_hd_huffman.c` / `lib/nghttp2_hd_huffman_data.c` | Huffman 码表与编解码，HPACK 可选分支，非主闭环 |
| `lib/nghttp2_map.c`、`lib/nghttp2_pq.c`、`lib/nghttp2_queue.c` | stream map、优先级队列、FIFO 队列的底层数据结构 |
| `lib/nghttp2_rcbuf.c` | 引用计数缓冲区（header 值共享） |
| `lib/nghttp2_submit.c` | 应用侧 API 帧提交（`nghttp2_submit_*`），入口在更上层 |
| `lib/nghttp2_callbacks.c` | 回调函数封装 |
| `lib/nghttp2_http.c` | HTTP 语义检查（伪头部合法性等） |

如需补齐某个文件，路径为 `https://raw.githubusercontent.com/nghttp2/nghttp2/v1.58.0/<该文件>`。

## 已复制 / 跳过说明

- **已复制**：`lib/nghttp2_session.c`、`lib/nghttp2_frame.c`、`lib/nghttp2_hd.c`、`lib/nghttp2_stream.c`、`lib/nghttp2_hd.h`；许可证 `LICENSES/COPYING`（MIT）。
- **跳过（404，上游不存在）**：任务清单中的 `lib/nghttp2_flow.c` 与 `lib/nghttp2_flow.h`。v1.58.0 的流控实现位于 `nghttp2_session.c` 内部（窗口字段、`nghttp2_session_enforce_flow_control_limits()`、`nghttp2_session_update_*_window_size()`、`session_update_*_consumed_size()`），本模块的流控阅读以 `nghttp2_session.c` 为准。
- **未复制**：与闭环无关的通用库、平台适配、构建脚本与生成文件（见上表依赖清单）；`nghttp2_hd_huffman.c` 属于可选分支，未纳入本次闭环。
- **许可证**：`../LICENSES/COPYING` 为 MIT 原文（Copyright (c) 2012, 2014, 2015, 2016 Tatsuhiro Tsujikawa and nghttp2 contributors）。仓库根目录另有 `LICENSE` 文件，其内容仅为一行 "See COPYING"，故未重复复制。