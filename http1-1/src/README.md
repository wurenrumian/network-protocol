# HTTP/1.1 · src

## 上游版本

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/nginx/nginx |
| tag | `release-1.25.3` |
| commit | `b8fb83b8d2e7ca03d43176b767f1fc657f1c1ee2` |
| 许可证 | BSD 2-Clause（见 `LICENSES/LICENSE`，来自上游 `docs/text/LICENSE`） |

## 文件清单（文件 → 类别 → 阅读范围）

复制自 `release-1.25.3`，保留上游相对路径 `src/http/`。

### core/ —— 协议本身

| 文件 | 类别 | 阅读范围 | 职责 |
| --- | --- | --- | --- |
| `src/http/ngx_http_parse.c` | core | 全文：`ngx_http_parse_request_line`（:104）、`ngx_http_parse_header_line`（:819）、`ngx_http_parse_uri`（:1097）、`ngx_http_parse_complex_uri`（:1248）、`ngx_http_parse_status_line`（:1624）、`ngx_http_parse_unsafe_uri`（:1842）、`ngx_http_parse_multi_header_lines`（:1964）、`ngx_http_parse_set_cookie_lines`（:2034）、`ngx_http_parse_chunked`（:2145） | 增量字节解析器：请求行、header 行、status line、chunked、URI 归一化 |
| `src/http/ngx_http_request.c` | core | 全文（3935 行）：请求状态机 `ngx_http_process_request_line`（:1083）、`ngx_http_process_request_headers`（:1367）、`ngx_http_process_request_header`（:1951）、`ngx_http_process_request`（:2040）；body 读取与 discard、`ngx_http_lingering_close_handler`（:3499）；连接生命周期：`ngx_http_finalize_connection`（:2735）、`ngx_http_set_keepalive`（:3081）、`ngx_http_close_connection`（:3794） | 请求处理主状态机与连接生命周期 |
| `src/http/ngx_http_core_module.c` | core | 全文（5325 行，含配置与 phase 逻辑）：`ngx_http_handler`（:820）、`ngx_http_core_run_phases`（:820 附近）、`ngx_http_send_header`（:1832）、`ngx_http_output_filter`（:1854）；调用 `ngx_http_discard_request_body`（:995、:1761）与 `ngx_http_read_client_request_body`（定义见「未复制的依赖」）；跳过：大量 `ngx_http_core_*` location/静态文件处理细节、配置解析宏（非本闭环必需） | handler 调度、响应输出；keepalive 判定与连接关闭见 `ngx_http_request.c` |

### integration/ —— 与事件循环 / socket 的衔接

| 文件 | 类别 | 阅读范围 | 职责 |
| --- | --- | --- | --- |
| `src/http/ngx_http_copy_filter_module.c` | integration | 全文（362 行）：`ngx_http_copy_filter`（:83）、`ngx_http_copy_filter_init`（:355） | 响应过滤链中复制 body、chunked 编码 |
| `src/http/ngx_http_header_filter_module.c` | integration | 全文（634 行）：`ngx_http_header_filter`（:157）、`ngx_http_header_filter_init`（:629） | 响应头/状态行序列化，输出链的最后一环 |
| `src/http/ngx_http.h` | core/integration | 相关声明：`ngx_http_parse_*`（:101–:109）、`ngx_http_headers_in_t`/`headers_out_t`、`ngx_http_core_main_conf_t` | 模块级声明与 parser 函数声明（无 `ngx_http_parse.h` 文件） |
| `src/http/ngx_http_request.h` | core | 相关声明：`ngx_http_request_t`、`ngx_http_headers_in_t`/`headers_out_t`、`ngx_http_request_line`/URI 相关字段 | 请求与响应共用的核心数据结构定义 |

### platform/ —— 无

缓冲区、socket、事件循环、线程池等底层依赖未复制，见「未复制的依赖」。

## 阅读顺序与调用链

按闭环「入口 → 解析 → 处理 → 输出 → 归还/关闭」：

```
ngx_http_init_request（accept 后，注册读事件）            [未复制，事件循环]
  → ngx_http_process_request_line        ngx_http_request.c:1083
      → ngx_http_parse_request_line      ngx_http_parse.c:104     ← 请求行状态机
      → （NGX_OK 后切换）
  → ngx_http_process_request_headers     ngx_http_request.c:1367
      → ngx_http_parse_header_line       ngx_http_parse.c:819    ← header 状态机
      → （空行结束头）
  → ngx_http_process_request_header      ngx_http_request.c:1951 （Host/Connection/TE/CL 后处理）
  → ngx_http_process_request             ngx_http_request.c:2040
      → ngx_http_handler                 ngx_http_core_module.c:820
          → ngx_http_core_run_phases     （11 个 phase，含 CONTENT phase 的 handler）
          → 响应：ngx_http_send_header   ngx_http_core_module.c:1832
              → ngx_http_header_filter   ngx_http_header_filter_module.c:157  ← 状态行+响应头
          → ngx_http_output_filter       ngx_http_core_module.c:1854
              → ngx_http_copy_filter     ngx_http_copy_filter_module.c:83     ← body/chunked
              → （写回 socket）
  → ngx_http_finalize_request
      → ngx_http_finalize_connection
          → ngx_http_set_keepalive       （归还连接） 或
          → ngx_http_lingering_close_handler   ngx_http_request.c:3499 → ngx_http_close_connection
```

chunked 两个方向的入口：

- 请求方向（解析）：`ngx_http_parse_chunked` `ngx_http_parse.c:2145`（由 body 读取路径调用）。
- 响应方向（编码）：`ngx_http_copy_filter` `ngx_http_copy_filter_module.c:83`。

## 入口函数 / 结束函数

| 方向 | 入口 | 结束 |
| --- | --- | --- |
| 请求接收 | `ngx_http_process_request_line`（`ngx_http_request.c:1083`，由事件循环的可读事件驱动） | 响应写完 + keepalive 归还（`ngx_http_set_keepalive`）或关闭（`ngx_http_close_connection`） |
| 解析 | `ngx_http_parse_request_line`（`ngx_http_parse.c:104`） | 最后一个 header 行完成 → `ngx_http_process_request` |
| 响应输出 | `ngx_http_send_header`（`ngx_http_core_module.c:1832`） | 过滤链末端写 socket（在未复制的输出过滤链中） |

## 未复制的依赖

这些是 nginx 构建/运行必需、但不在本 HTTP/1.1 闭环阅读范围内的文件，仅在需要深入时补：

| 依赖 | 说明 |
| --- | --- |
| `src/event/*` | epoll/kqueue 等事件循环与连接注册（`ngx_event_*`），驱动 `ngx_http_process_request_line` 的可读事件来源 |
| `src/core/ngx_connection.*` | `ngx_connection_t`、`ngx_buf_t`（`ngx_http_parse_*` 的 `ngx_buf_t *b` 参数来源） |
| `src/core/ngx_http_request.*`（若有） | `ngx_http_request_t` 定义依赖的基础结构（实际定义在 `src/http/ngx_http.h`，未复制其上游目录层级） |
| `src/http/ngx_http_request_body.c` | body 读取与 discard（`ngx_http_read_client_request_body`、`ngx_http_discard_request_body`）的实际定义处，本模块的 `ngx_http_core_module.c:995/:1761` 等直接调用它；未复制，是文档反复引用的机制，需回上游补充阅读 |
| `src/http/ngx_http_special_response.c` | 400/414 等错误页生成（错误路径可选补） |
| `src/http/ngx_http_upstream.*` | 反向代理到上游（status line 解析的另一个调用者，旁支） |
| 构建系统 | `auto/*`、各 `Makefile`，不参与协议阅读 |
| `src/core/ngx_log.*` | 日志（阅读时可不追） |

## 已复制 / 跳过说明

- **已复制**：5 个 `.c` 文件 + `ngx_http.h` + `ngx_http_request.h` + `LICENSES/LICENSE`（共 9 个文件）。
- **跳过（404，已核实上游不存在）**：
  - `src/http/ngx_http_parse.h` —— nginx 仓库不存在此文件；parser 函数声明在 `src/http/ngx_http.h`（:101–:109）。因此用 `ngx_http.h` 替代以满足「声明与解析器对应」的需求，已在文件清单中标明。
  - 仓库根目录 `LICENSE` —— nginx 将许可证文本放在 `docs/text/LICENSE`，已据此下载到 `src/LICENSES/LICENSE`（内容为 BSD 2-Clause，含 `Copyright (C) 2002-2021 Igor Sysoev` 与 `Copyright (C) 2011-2023 Nginx, Inc.`）。<br>
- 七个源码文件（5 个 `.c` + `ngx_http.h` + `ngx_http_request.h`）均从 tag `release-1.25.3` 的 raw URL 原样下载，未做任何修改；学习注释按根目录 §3 规范写在副本上即可。
- 裁剪说明：`ngx_http_core_module.c` 含大量配置解析与 location/静态文件逻辑，阅读时跳过，仅追踪本闭环相关函数（见文件清单）；其余文件建议全文通读。