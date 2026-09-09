# HTTP/1.1 · protocol

## 问题定义

HTTP/1.1 要解决的核心问题是：**在一组持久（keepalive）TCP 连接上，可靠、无歧义地交换若干对「请求/响应」消息**。

约束与目标：

- 消息是无状态语义的（每个请求独立），但连接是有状态的（可复用）；
- 连接上只有字节流，没有帧边界，因此必须靠**消息自身的定界规则**（header 以空行结束、body 以 content-length 或 chunked 结束）来切分消息；
- 连接必须既能被无界复用，又能在任何一方决定结束时被干净地关闭，且不能把「半截消息」误认为完整消息；
- 客户端与服务端可以随时结束连接（网络故障、超时、优雅关闭），剩余未读数据需要按协议语义丢弃（discard / lingering close）。

问题分解为四个子问题：

1. **定界**：消息头到哪里结束、body 有多长、下一条消息从哪里开始。
2. **复用**：keepalive 条件下多个请求如何有序地到达同一个处理流程。
3. **级联**：TCP 数据在收到 FIN 时是「连接被关闭」还是「只是消息结束」，如何区分。
4. **错误模型**：语法错误、长度不一致、半关闭等情形下，发送 4xx/5xx 后如何终止连接。

## 抽象对象

| 对象 | 字段 | 生命周期 | 对应 nginx 结构 |
| --- | --- | --- | --- |
| 请求 message | 请求行（method、target URI、HTTP 版本）、header 字段集合、可选 body | 从请求行首个字节读到 body 结束 | `ngx_http_request_t` |
| 响应 message | 状态行（版本、status code、reason phrase）、header 集合、可选 body | 从状态行首字节写到 body 结束 | 同一 `ngx_http_request_t`（复用作响应上下文） |
| 连接 | 双向字节流、对端地址、keepalive 状态、关闭中状态 | 从 accept 到 close | `ngx_connection_t` / `c->http_connection` |
| header 字段集合 | name/value 对的有序列表 + 重复字段合并规则 | 与所在消息同生命周期 | `ngx_http_headers_in_t` / `ngx_http_headers_out_t` |
| body | 字节序列 + 定界方式（无 body / content-length / chunked）+ 读取状态 | 消息生命周期内 | `ngx_http_request_body_t`、`ngx_http_request_t` 上的 body 相关标志 |
| URI | target（origin-form 或 absolute-form）、查询串、归一化结果 | 解析到处理完成 | `r->uri`、`r->args`、`r->unparsed_uri` |

关键点：nginx 中**一个请求对象同时承载请求和响应**。响应不是独立对象，而是请求在「处理完请求、开始生成响应」之后在同一结构上的输出阶段。请求对象内的状态位（如 `r->headers_in.chunked`、`r->discard_body`、`r->keepalive`）记录处理到哪一步。

## wire format

字节流按以下顺序出现（RFC 9112 §2）：

```
request-line = method SP request-target SP HTTP-version CRLF
header-field = field-name ":" OWS field-value OWS CRLF
               （头字段可以多个，以空行 CRLF 结束）
[ message-body ]

HTTP-version = "HTTP/" DIGIT "." DIGIT    ; 1.0 / 1.1
```

- **请求行**：`GET /index.html HTTP/1.1\r\n`。method 是 token；target 对代理为 absolute-form（绝对 URI），对源服务器为 origin-form（`/path?query`）；版本由 `ngx_http_parse_request_line` 识别为 HTTP/1.0 或 HTTP/1.1。
- **头字段**：`Name: value\r\n`。nginx 按名称分派到 `ngx_http_headers_in_t` 的对应槽位；未知字段归入通用列表。空行表示 header 结束。
- **body**（RFC 9112 §6.3）：四种情况，只允许其中一种：
  1. 有 `Transfer-Encoding: chunked` 时，body 是 chunked 编码（见下）；
  2. 否则有 `Content-Length: N` 时，body 恰为 N 字节；
  3. 请求方法本身允许无 body（GET/HEAD 等，或请求有明确语义）——`Content-Length: 0` 也视为无 body；
  4. 都没有时，body 长度为零。
- **chunked 编码**（RFC 9112 §7.1）：
  ```
  chunked-body = *chunk last-chunk trailer-section CRLF
  chunk        = chunk-size [ chunk-ext ] CRLF chunk-data CRLF
  last-chunk   = "0" [ chunk-ext ] CRLF
  ```
  每个 chunk 以十六进制大小开头、紧跟 CRLF、然后是数据、再 CRLF；最后是 `0` 大小 chunk 与可选的 trailer 头，以空行结束。优点：不需要预先知道长度、可流式发送；缺点：多一层编码开销，因此 nginx 只在「无 Content-Length 且连接不可复用（如必须关闭）」时对响应启用，见后文「设计取舍」。
- **keepalive 连线语义**：HTTP/1.1 默认连接复用（除非请求/响应带 `Connection: close`）；HTTP/1.0 默认不复用（除非带 `Connection: keep-alive`）。复用意味着下一条请求直接跟在当前响应的最后一个字节之后。

## 核心机制

### 1. 解析（parser）

nginx 采用**增量解析 + 状态机**：`ngx_http_parse.c` 的每个解析函数对缓冲区 `b` 逐字节推进，返回三种结果之一：

| 返回值 | 含义 | 调用方行为 |
| --- | --- | --- |
| `NGX_OK` | 本段（请求行/一个头/状态行）解析完成 | 进入下一段 |
| `NGX_AGAIN` | 缓冲区已读完但语法未定论（可能只是数据没到） | 继续读 socket，再以更大缓冲区调用 |
| `NGX_HTTP_PARSE_INVALID_*` | 语法错误 | 构造 400 并关闭或降级连接 |

解析器只做**字节层判定**，不做协议语义判定：例如 URI 是否合法由 `ngx_http_parse_complex_uri` 负责，header 个数是否超限由 `ngx_http_process_request_headers` 负责。解析器把结果写入 `r->request_line`、`r->method_name`、`r->headers_in` 等结构，且**只允许 8-bit 安全字节**：控制字符、空格、非 ASCII 高字节等都按字符表（`usual[]`）逐位拒绝。

解析各阶段：

- **request line**：`ngx_http_parse_request_line`（`ngx_http_parse.c:104`）。切 method、SP、URI、HTTP 版本、CRLF。
- **header 行**：`ngx_http_parse_header_line`（`ngx_http_parse.c:819`）。逐行切 name/value，折叠行（obs-fold，RFC 7230 废弃）被拒；处理 `Host`、`Content-Length`、`Transfer-Encoding` 等关键头。
- **status line**：`ngx_http_parse_status_line`（`ngx_http_parse.c:1624`），供反代理（HTTP/1.1 到上游）与自身响应解析使用。
- **chunked**：`ngx_http_parse_chunked`（`ngx_http_parse.c:2145`）增量解析 chunk 头、数据与 trailer。
- **URI 归一化**：`ngx_http_parse_complex_uri` 处理 `.`、`..`、重复斜杠合并（`merge_slashes`），`ngx_http_parse_unsafe_uri` 用于鉴权前的安全性检查。

### 2. 方法 / 头 / 状态码

- **方法**：`ngx_http_parse_request_line` 把请求行首 token 与常用方法名（GET/HEAD/POST/PUT/DELETE/CONNECT/OPTIONS/TRACE/PATCH 等）比较，匹配时记录为 `r->method` 位标志，未识别的方法仍保留原字符串 `r->method_name`（nginx 允许扩展方法）。`r->method` 位标志使 location 匹配、静态/代理判定等都以位运算完成。
- **头**：解析完成后 `ngx_http_process_request_header`（`ngx_http_request.c:1951`）统一后处理——检查必须的 `Host`（HTTP/1.1 必须）、处理 `Connection` 与 keepalive 判定、合并重复字段、设置 `r->headers_in.chunked` 等标志。
- **状态码**：handler 设置 `r->headers_out.status`；响应输出前 `ngx_http_header_filter` 生成状态行与响应头。状态码决定响应是否有 body（1xx/204/304 无 body）。

### 3. keepalive

keepalive 判定在 `ngx_http_request.c:2040 ngx_http_process_request` 与 `ngx_http_core_module.c` 的收尾处进行：

- 解析阶段发现 `Connection: close` 或请求/响应要求关闭 → `r->keepalive = 0`；
- 正常响应完成后，若 `r->keepalive` 为真且客户端连接仍可复用，调用 `ngx_http_set_keepalive` 把连接**归还给事件循环**，挂回空闲连接链表等待下一条请求；
- 若请求带 body 而未读完，必须先 `ngx_http_discard_request_body` 把 body 从 socket 读走并丢弃，否则下一条请求的头会被误当成 body 解析。

keepalive 的代价：连接处于空闲时可能被 `keepalive_timeout` 定时器超时关闭；复用要求响应必须能确定 body 边界（否则无法知道下一条请求从哪里开始）。

### 4. chunked 与 content-length

- **请求方向（解析）**：`ngx_http_parse_chunked` 增量消费 chunk；`r->headers_in.chunked` 标志由 `ngx_http_process_request_header` 在解析到 `Transfer-Encoding: chunked` 时设置。若 `Content-Length` 与 `Transfer-Encoding` 同时出现，nginx 按 RFC 优先采用 chunked（并处理 TE 中多值的情况，只允许 `chunked` 且必须最后出现）。
- **响应方向（编码）**：`ngx_http_copy_filter_module.c` 在输出过滤链中把 body 拆成 chunk（`ngx_http_copy_filter` 对单个 buffer 计算 chunk 头）；`ngx_http_chunked` 标志控制是否启用以 `0\r\n\r\n` 结尾。nginx 默认只有 `Content-Length` 未知**且**连接将关闭时才用 chunked——因为 chunked 增加字节开销，nginx 宁可 `Connection: close` + 裸 body。
- **content-length 一致性**：客户端声称的 content-length 与实际接收量不一致属于协议错误，nginx 在 `ngx_http_read_client_request_body` 路径中检测多读/少读并报错。

### 5. 管道（pipelining）

HTTP/1.1 允许客户端不等待响应就连续发送多个请求（RFC 9112 §3.3.2）。nginx 的处理方式是**不专门支持管道**：多个请求如果已同时到达，会按到达顺序逐个进入正常处理流程（状态机天然消费完一条消息才处理下一条）；nginx 不为此维护管道队列，也不承诺管道语义。实际上一个请求处理到「输出完成并归还连接」之前，其后的数据仍在缓冲区中排队。keepalive 关闭判定只依赖当前消息，不受已排队但未处理请求影响。

### 6. 关闭语义：linger / discard

连接关闭是最容易出错的环节，nginx 有专门机制：

- `ngx_http_discard_request_body`：客户端发了 body 但 handler 不需要时，仍把 body 读尽丢弃，从而保持「读完消息 → 归还连接」的不变量。若读到一半发现连接关闭，则结束。
- `ngx_http_lingering_close_handler`（`ngx_http_request.c:3499`）：nginx 决定关闭时，先只关闭写方向（shutdown write），在 `lingering_timeout` 时间内继续读 socket，防止「发送 RST 之前 peer 仍在发送数据」导致的 `connection reset by peer` 被客户端误读。超时或读尽后调用 `ngx_http_close_connection` 真正关闭。

## 设计取舍

| 取舍 | nginx 的选择 | 理由 |
| --- | --- | --- |
| 解析器是否复制字节 | 不复制，只对缓冲区做指针/偏移扫描，结果落到 `ngx_http_headers_in_t` 槽位 | 高吞吐、避免每请求多次 memcpy |
| 未知头如何处理 | 放入通用 header 链表，不逐字保存 | 保持热路径简单 |
| chunked 是否默认用于响应 | 默认关闭，仅在无 CL + 关闭连接时启用 | chunked 有开销；直接裸 body 更省 |
| 管道是否专门支持 | 不专门支持 | nginx 单请求模型，有序消费即可 |
| 失败后是否可复用连接 | 解析错误/协议错误一律关闭连接（RFC 要求「可靠」服务器不得在解析错误后复用一个请求的确定性） | 防止请求走私（request smuggling）类歧义 |
| body 读取时机 | handler 显式调用 `ngx_http_read_client_request_body`；不调用则 discard | 把 I/O 从解析中剥离 |
| 是否实现 HTTP/1.0 兼容 | 支持：1.0 默认关闭 keepalive，除非 `Connection: keep-alive` | 旧客户端互通 |

## 不变量

以下不变量贯穿 nginx HTTP/1.1 实现，阅读源码时用来验证正确性：

- **消息定界唯一性**：任何时刻，连接上「已解析消息」与「未解析字节」的边界都是确定的；没有一条消息在无定界（无 CL、无 chunked、连接不关闭）的情况下被声称完整。
- **读到消息末尾才处理**：handler 只在一个请求的 head（和需要的 body）完全到达后运行；未到末尾的请求数据不会进入处理阶段。
- **归还连接的连接必然已读尽当前消息**：`ngx_http_set_keepalive` 之前的路径必须保证当前请求的 body 已被消费或 discard，否则不归还。
- **一个 socket 同一时刻只有一个请求的 I/O**：请求对象与连接一对一，管道请求按到达顺序串行处理。
- **响应与请求在同一请求对象上**：请求的 `headers_out` 只在处理请求后被填充，不存在「上一个响应的头泄漏到下一个请求」。
- **解析只推进，不回溯**：解析器消费过缓冲区的位置不回头，失败的解析不部分提交状态。

## 边界条件与异常处理

| 边界/异常 | 处理 | 对应源码 |
| --- | --- | --- |
| 请求行过长（默认 8KB，`large_client_header_buffers`） | `414 Request-URI Too Large` | `ngx_http_process_request_line` 超限分支 |
| 头字段个数或总长超限（`large_client_header_buffers`） | `400 Bad Request` | `ngx_http_process_request_headers` 超限分支 |
| 非法字符（控制字符、CRLF 嵌在值中、obs-fold） | 解析返回 `NGX_HTTP_PARSE_INVALID_*`，`400` | `ngx_http_parse_header_line` |
| HTTP/1.1 缺少 `Host` 头 | `400 Bad Request`（RFC 9112 §3.2 要求） | `ngx_http_process_request_header` |
| `Content-Length` 与 `Transfer-Encoding` 并存 | 以 chunked 为准；TE 含非 chunked 值报 501/400 | `ngx_http_process_request_header` |
| 声明 CL 与实际 body 不符（多读/少读） | 读 body 时报错，最终关闭连接 | `ngx_http_read_client_request_body` |
| chunked 中 `0` 后还有数据（无 trailer 时） | 解析继续；若出现非法 trailer 报 400 | `ngx_http_parse_chunked` |
| 客户端在 body 读完前断连 | discard 路径返回错误，连接回收 | `ngx_http_discard_request_body` |
| `expect: 100-continue` | nginx 可发 `100 Continue` 后继续读 body（默认在读取 body 时才响应） | `ngx_http_read_client_request_body` 相关分支 |
| keepalive 空闲超时 | `keepalive_timeout` 定时器关闭连接 | `ngx_http_set_keepalive` |
| 响应无 CL 且连接不能复用 | 输出裸 body + `Connection: close`，或启用 chunked | `ngx_http_copy_filter` 前的判定 |
| 优雅关闭时的对端残留数据 | lingering close：只关写方向，读尽剩余数据或超时 | `ngx_http_lingering_close_handler` |
| 请求走私防护 | 解析错误/歧义一律关闭连接，不复用 | 各解析错误路径 + `ngx_http_close_connection` |

异常处理的总原则：**解析或协议错误发生后，绝不把连接误判为可复用**。这是防止请求走私（RFC 9112 及各家安全公告反复强调）的关键不变量——正因为多个 HTTP 实现（nginx、curl、llhttp）的解析行为差异正是走私攻击的土壤，对照实现阅读对理解这点很有价值。