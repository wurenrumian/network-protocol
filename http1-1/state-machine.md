# HTTP/1.1 · state-machine

nginx 的 HTTP/1.1 状态机分两层：

1. **请求解析状态机**（字节级）：由 `ngx_http_parse_request_line` / `ngx_http_parse_header_line` / `ngx_http_parse_chunked` 用 switch 逐字节驱动，输入是缓冲区，输出是解析结果与 `r->headers_in` 槽位。
2. **请求处理生命周期**（事件级）：由事件循环驱动 `ngx_http_process_request_line → process_request_headers → process_request`，描述一条请求从字节到达、到处理、到响应、到归还/关闭连接的流转。

## 状态

### 解析状态机（字节级，`ngx_http_parse.c`）

`ngx_http_parse_request_line` 内部的状态：

| 状态 | 含义 |
| --- | --- |
| `sw_start` | 等待请求行首字节 |
| `sw_method` | 收集 method token |
| `sw_spaces_before_uri` | method 与 URI 间的空格 |
| `sw_schema` / `sw_schema_slash` / `sw_schema_slash_slash` | absolute-form URI 的 scheme `http://` |
| `sw_host` / `sw_port` / `sw_host_done` | absolute-form 的 host 与 port |
| `sw_after_slash_in_uri` | 处理 URI 路径 |
| `sw_check_uri` / `sw_uri` | origin-form URI 校验与收集 |
| `sw_http_09` / `sw_http_10` / `sw_http_20` | 解析 `HTTP/1.x` 版本各字节 |
| `sw_almost_done` | 等待 CRLF 的 LF |
| `sw_done` | 请求行完成 |

`ngx_http_parse_header_line` 内部状态：`sw_start`（行首）、`sw_name`（字段名）、`sw_space_before_value`、`sw_value`、`sw_almost_done`（CR 后等待 LF）、`sw_header_done`（空行 = 头结束）、`sw_error`。

### 请求处理生命周期（事件级）

| 状态 | 含义 |
| --- | --- |
| `HTTP_READING_REQUEST_STATE` | 等待/读取请求行与头（事件回调中解析） |
| `HTTP_PROCESSING_REQUEST_STATE` | 头部已就绪，`ngx_http_process_request` 中运行 handler、读取 body |
| `HTTP_WRITING_REQUEST_STATE` | 输出响应中 |
| `HTTP_KEEPALIVE_STATE` | 响应写完，连接归还事件循环等待下一条请求 |
| `HTTP_CLOSING_STATE` | 决定关闭，进行 lingering close |
| `HTTP_DISCARDING_REQUEST_STATE` | 丢弃未读完的请求 body（等待 body 数据到来后读尽） |
| `HTTP_READING_BODY_STATE` / `HTTP_READING_CHUNKED_STATE` | 读取普通 / chunked body |

这些状态存于 `r->http_state`，主要在 `ngx_http_terminate_request` / `ngx_http_finalize_request` 的收尾路径中更新，用于调试与事件注册决策。

## 事件

| 事件 | 触发者 | 状态转移 |
| --- | --- | --- |
| socket 可读（`NGX_HTTP_READ_REQUEST` 事件） | `ngx_http_init_request` 注册的读事件 → `ngx_http_process_request_line` | READING → （完整请求行后）→ headers 解析 |
| 请求行解析 `NGX_OK` | `ngx_http_process_request_line` 切换处理函数 | → `ngx_http_process_request_headers` |
| 头解析 `NGX_OK`（遇到空行） | `ngx_http_process_request_headers` | → `ngx_http_process_request` |
| 头部处理完成 | `ngx_http_process_request` → `ngx_http_handler` | → `ngx_http_core_run_phases`（11 个 handler 阶段） |
| handler 需要 body | `ngx_http_read_client_request_body` | → body 读取；否则 → discard 或直接输出 |
| 响应输出完成 | `ngx_http_finalize_request` → 输出过滤链返回 | → keepalive 判定 |
| keepalive 且连接可复用 | `ngx_http_set_keepalive` | → KEEPALIVE（挂回空闲连接链表，注册新读事件） |
| 需关闭 / 错误 | `ngx_http_finalize_connection` / `ngx_http_close_connection` | → CLOSING（lingering close）→ 关闭 |

## 状态转移

### 请求 line → header → body（`ngx_http_request.c`）

```
readable event
   │  ngx_http_process_request_line  (ngx_http_request.c:1083)
   ▼
ngx_http_parse_request_line(r, header_in)
   ├─ NGX_AGAIN  → 等待更多数据，重新注册读事件
   ├─ NGX_HTTP_PARSE_INVALID_* → 构造 400 → finalize（关闭连接）
   └─ NGX_OK
        ├─ 处理 r->method、r->uri 等
        └─ 切换 state 为 process_request_headers
                ▼
        ngx_http_process_request_headers  (ngx_http_request.c:1367)
        ngx_http_parse_header_line(r, b)
           ├─ NGX_AGAIN → 继续读
           ├─ INVALID / 超限 → 400
           └─ NGX_OK（空行=头结束）
                 ▼
        ngx_http_process_request_header  (ngx_http_request.c:1951)
           ├─ 校验 Host、处理 Connection/Transfer-Encoding/Content-Length
           └─ ▼
        ngx_http_process_request  (ngx_http_request.c:2040)
           ├─ discard body（若 handler 不需要且 request 无 body 读取）
           └─ ▼
        ngx_http_handler  → ngx_http_core_run_phases
```

### 解析器内部转移（`ngx_http_parse.c`，request line 示例）

```
sw_start --[ 可见 token 字节 ]--> sw_method
sw_method --[ SP ]--> sw_spaces_before_uri
sw_spaces_before_uri --[ '/' ]--> sw_check_uri
sw_check_uri --[ 合法 path 字节 ]--> sw_uri
sw_uri --[ SP ]--> sw_http_09 --[ 'H' ]--> sw_http_10 --[ 'T'..'1' ]--> sw_http_20
sw_http_20 --[ '.' + 单个数字 ]--> sw_almost_done --[ CR ]--> sw_almost_done --[ LF ]--> sw_done
任意状态 --[ 非法字节/坏 CR ]--> 返回 INVALID
任意状态 --[ 缓冲耗尽 ]--> 返回 NGX_AGAIN（记录已消费位置，下次从当前位置继续）
```

关键不变量：**`NGX_AGAIN` 时 parser 必须已把内部游标推进到正确位置**，这样下次带更多数据调用才能继续而不是从头重扫。这是 nginx 增量解析无回溯的基础。

### chunked body（`ngx_http_parse_chunked`）

```
chunk 头： 十六进制 size [; 扩展] CRLF → 读 size 字节数据 → CRLF → 下一个 chunk 头
size==0：  进入 trailer 区，遇空行 CRLF → 结束
```
返回 `NGX_OK`（一个 chunk 完成，包含数据长度与位置）或 `NGX_AGAIN`（未完成）/ `INVALID`（size 非十六进制、缺 CRLF 等）。

## 正常 / 异常时序

### 正常 keepalive 时序

```
client                 nginx
  │ GET /a HTTP/1.1       │
  ├───────────────────────▶ 可读事件 → parse line → parse headers
  │                       │ process_request → handler 生成 /a
  │◀────────────────────── 200 OK, Content-Length: N, body(N)
  │                       │ finalize → keepalive → 归还连接，注册新读事件
  │ GET /b HTTP/1.1       │
  ├───────────────────────▶ 同一连接、同一请求对象重置后重新解析
  │◀────────────────────── 200 OK, ... 
```

### keepalive 关闭时序（`Connection: close` 或错误）

```
client                        nginx
  │ GET / HTTP/1.1            │
  │ Connection: close         │
  ├───────────────────────────▶ 解析 → process_request → 响应
  │◀────────────────────────── 200 OK, Connection: close（或裸 body + close）
  │                           │ keepalive=0 → finalize_connection
  │                           │   → lingering close（shutdown write，继续读）
  │ FIN ◀─────────────────────│ 读尽/超时后 close_connection
```

### 异常时序一：请求头未读完客户端断连

```
parse headers 读到一半，recv 返回 0（EOF）
   → 此时若已有 0 个完整请求头，直接 finalize（无响应可发）
   → 若已部分解析出请求行，nginx 判定「请求行不完整即 EOF」→ 400/关闭
```

### 异常时序二：body 与 content-length 不符

```
client 声明 CL: 100，实际只发 50 字节后 FIN
   → discard/read body 读到 EOF，读到的字节数 < 100
   → 上报错误，连接关闭，不复用
```

### 异常时序三：解析错误（如非法字符）

```
parse_header_line 返回 INVALID
   → 立即构造 400 响应（若有足够上下文）
   → 响应完成后 finalize_connection，keepalive=0，关闭连接
   → 绝不复用连接（防止请求走私）
```

## 处理流程（无显式状态机时）

nginx 的 HTTP/1.1 请求处理使用**事件回调换人**的模式，等价于一个由 `r->http_state` 记录、由事件循环驱动的隐式状态机：

- `ngx_http_init_request`：accept 后初始化 `ngx_http_request_t`，注册读事件 → `ngx_http_process_request_line`；
- 解析回调各自「解析 → 判定 → 切换到下一个回调」，直到 `ngx_http_process_request` 交出控制权给 11 个 handler 阶段（`ngx_http_core_run_phases`，`ngx_http_core_module.c:820`）——其中 `NGX_HTTP_SERVER_REWRITE_PHASE`、`NGX_HTTP_FIND_CONFIG_PHASE`、`NGX_HTTP_ACCESS_PHASE`、`NGX_HTTP_CONTENT_PHASE` 等依次执行；
- 内容阶段产出响应，经 `ngx_http_send_header` + `ngx_http_output_filter`（过滤链）写回 socket；
- `ngx_http_finalize_request` 收尾：判定 keepalive、discard 未读 body、lingering close、释放 `ngx_http_request_t`。

这条「解析 → 阶段 → 过滤 → 归还」的路径即 `src/README.md` 的调用链主线。