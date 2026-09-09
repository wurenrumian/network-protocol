# HTTP/2 · protocol

## 问题定义

HTTP/1.1 的请求响应模型有几个结构性缺陷：

1. **队头阻塞（head-of-line blocking）**：同一连接上一次只能处理一个请求/响应，响应串行返回；keepalive 只能串行复用连接，pipelining 有实现与语义上的问题，且仍要求按序响应。
2. **头部冗余**：每个请求重复携带大量相同或相近的头部（Cookie、User-Agent、Host 等），明文文本编码浪费带宽。
3. **并发手段粗糙**：浏览器用多 TCP 连接（通常 6 条）绕开串行，代价是握手、TLS 与流控开销成倍放大，且无法解决连接内部的对头阻塞。
4. **无流级取消**：请求发出后无法单独放弃，只能断开连接。

HTTP/2 的目标：在**单一 TCP 连接**上通过**二进制分帧 + 多路复用流**消除应用层队头阻塞，用 **HPACK** 消除头部冗余，用**流优先级**表达资源竞争关系，并显式提供流级取消（RST_STREAM）与 GOAWAY 优雅关闭。

HTTP/2 不负责：

- TCP 的可靠传输、拥塞控制、重传（沿用 TCP）；
- 端到端加密（可由 TLS 提供，但协议本身不强制）；
- 应用语义（HTTP 语义不变，仍由 method/path/headers/body/status 构成）。

## 抽象对象

| 对象 | 职责 | 关键字段 |
| --- | --- | --- |
| **连接（session）** | 承载所有帧与流的容器，维护连接级窗口、SETTINGS、对端协商参数 | `local/remote_settings`、`local_window_size`、`remote_window_size`、`streams`（map） |
| **帧（frame）** | wire 上的最小传输单元，有统一 9 字节帧头 | 帧头：length(3) + type(1) + flags(1) + stream_id(4) |
| **流（stream）** | 一次请求/响应的双向字节流，有独立状态与窗口 | `stream_id`、`state`、`local/remote_window_size`、优先级（`prio`）、`outstanding_promise` 等 |
| **HPACK 动态表** | 收发两端各自维护的头部索引表，随会话演进 | 动态表 entries、`hd_table_bufsize`、`hd_table_bufsize_max` |
| **WINDOW_UPDATE 机制** | 流量控制的调节通道，按连接/按流独立 | `window_size_increment`、`stream_id` |

关键区别：**帧属于连接，流属于一次交换**。一个流上可以承载多个帧（HEADERS、DATA、CONTINUATION、RST_STREAM），同一帧（帧头中的 stream_id）区分归属。

## wire format

### 帧头（9 字节，RFC 7540 §6.1）

```
+-----------------------------------------------+
|        Length (24 bits)                        |   payload 长度，不含帧头本身
+-----------------------------------------------+
|   Type (8 bits)                                |   帧类型
+-------------------------------+---------------+
|  Flags (8 bits)               | R | Stream Identifier (31 bits) |
+-------------------------------+---------------+
```

- Length 上限由对端 SETTINGS_MAX_FRAME_SIZE 决定，默认 16384；超限为 FRAME_SIZE_ERROR（连接错误）。
- Flags 按帧类型定义：END_STREAM、END_HEADERS、PADDED、ACK、PRIORITY 等。
- Stream Identifier 用低 31 位；bit 0 是保留位（必须为 0，否则 PROTOCOL_ERROR）。

### 帧类型（RFC 7540 §6.2–§6.9）

| 类型 | 值 | 作用 | 常用标志 |
| --- | --- | --- | --- |
| DATA | 0x0 | 请求/响应正文 | END_STREAM、PADDED |
| HEADERS | 0x1 | 打开流、携带头块 | END_STREAM、END_HEADERS、PADDED、PRIORITY |
| PRIORITY | 0x2 | 设置流依赖与权重 | — |
| RST_STREAM | 0x3 | 终止流（错误码） | — |
| SETTINGS | 0x4 | 参数协商 | ACK |
| PUSH_PROMISE | 0x5 | 服务器推送 | END_HEADERS、PADDED |
| PING | 0x6 | 连接活性/RTT 测量 | ACK |
| GOAWAY | 0x7 | 连接优雅关闭 | — |
| WINDOW_UPDATE | 0x8 | 窗口增量 | — |
| CONTINUATION | 0x9 | 延续头块 | END_HEADERS |

### 流 ID 规则

- 客户端发起的流使用奇数 ID，服务器使用偶数 ID（PUSH_PROMISE 的 promised-stream-id 用对端方向奇偶）。
- 新建流 ID 必须单调递增；收到不大于已使用 ID 的帧视为 PROTOCOL_ERROR（stream reuse 攻击）。
- 新流 ID 达到 2^31-1 时，对端应发 GOAWAY（RFC 7540 §6.8）。

### HPACK 头部块

头部在 HEADERS/PUSH_PROMISE/CONTINUATION 帧中传输，经 HPACK 编码。编码形式：

- **静态表**：固定 61 项常用头部（`:method`、`:status`、`content-length` 等），用 1 字节索引引用；
- **动态表**：会话过程中由发送方维护，新头块可"添加"到表头，后续用索引引用；容量受双方协商的 `SETTINGS_HEADER_TABLE_SIZE` 限制（默认 4096）；
- **索引头字段**（Indexed Header Field）：`1` + 7 位索引，引用静态或动态表；
- **字面头字段**（Literal Header Field）：可增量索引 / 不索引 / 永不索引，可附 Huffman 编码与前缀整数。

编码类型由首个 bit 区分（RFC 7541 §6），前缀整数编码用于表示索引、长度等可变整数（RFC 7541 §5）。

## 核心机制

### 多路复用（RFC 7540 §5）

单个 TCP 连接上多个流交叉发送帧。帧头中的 stream_id 将每个帧归属到具体流；接收方按流重组语义，应用层不再受"一次一个请求"限制。连接级对头阻塞只剩 TCP 层（数据包丢失时 TCP 仍会阻塞后续字节）。

### 流优先级（RFC 7540 §5.3）

- 每个流可声明**依赖另一个流**（用父流 ID）与**权重**（1–256）；
- 依赖形成树，权重决定兄弟流之间资源分配比例；
- nghttp2 用 `nghttp2_stream.c` 中的优先级队列（`nghttp2_pq` + `stream_obq_*`）在发送端选择下一个发送哪个流的帧；
- 优先级是提示性的，接收方/代理可忽略；错误使用会形成依赖环，规范要求环路按 PROTOCOL_ERROR 或忽略处理（nghttp2 对 `:pri` 扩展另有处理，见 `nghttp2_extpri.c`）。

### 流控（RFC 7540 §6.9）

- 基于**逐跳**（hop-by-hop）的信用窗口：发送方维护 `remote_window_size`（对端允许的剩余发送量），每发一帧递减；接收方处理完数据后发 WINDOW_UPDATE 回补。
- 两级窗口：**连接级**（stream_id=0）与**流级**（每个流独立），发送量受两级窗口共同约束（取 min）。
- 初始窗口由 `SETTINGS_INITIAL_WINDOW_SIZE` 协商，默认 65535；调整该 SETTINGS 会按差值更新所有流（需防窗口溢出，增量过大为 FLOW_CONTROL_ERROR）。
- WINDOW_UPDATE 增量为 0 视为 PROTOCOL_ERROR；DATA 帧超窗发送视为 FLOW_CONTROL_ERROR（连接错误）。
- nghttp2 实现：`nghttp2_session.c` 中的 `nghttp2_session_enforce_flow_control_limits()` 计算可发送量；接收侧在 `nghttp2_session_update_recv_*_window_size()` 回补，并主动 `nghttp2_session_update_local_window_size()` 限制内存。

### HPACK（RFC 7541）

- 收发两端**对称**维护动态表，解压结果依赖压缩前的完整历史（stateful）；
- 编码器按 `SETTINGS_HEADER_TABLE_SIZE` 限制动态表总大小，超限时按 LRU 驱逐最旧条目；
- 解码端必须保持同步；表容量以 `dynamic table size update` 指令协商变更；
- 解码失败（如非法索引）按 **COMPRESSION_ERROR** 处理（连接错误，RFC 7540 §4.2）；
- 由于依赖历史状态，**任何一端丢包或重置后必须整连接重建**——这是 HPACK 与 QUIC/QREMR 对比的关键差异。

### 连接与流错误（RFC 7540 §5.1.2、§7）

- **连接错误**：frame/流控/压缩等协议级错误，终止整个连接（GOAWAY 或直接关闭）；
- **流错误**：影响单个流的错误，用 RST_STREAM 带错误码终止该流，其他流不受影响；
- nghttp2 用 `nghttp2_session_terminate_session()` 统一进入终止路径，`nghttp2_session_close_stream()` 处理单流关闭。

### SETTINGS 与 GOAWAY

- **SETTINGS**：连接建立后首先交换，协商帧大小、初始窗口、头表大小、enable_push 等；收到 SETTINGS 必须回复 ACK SETTINGS；
- **GOAWAY**：携带 last-stream-id（已处理的最后一个流）与错误码，告知对端"别再发新流，我会尽快处理完既有流"。实现优雅关闭，避免 RST 风暴；`nghttp2_session_terminate_session()` 内部即排队 GOAWAY。

## 设计取舍

1. **二进制分帧换可解析性**：帧头固定 9 字节，长度前置，解析简单高效，代价是 wire 不再可人工阅读（需要 `nghttp`/Wireshark 等工具）。
2. **单一连接换队列头阻塞残留**：多路复用解决了 HTTP 层阻塞，但 TCP 层的队头阻塞仍在；这正是 HTTP/3/QUIC 的动机。HTTP/2 选择不改传输层（复杂度、部署成本低）。
3. **HPACK 有状态换压缩率**：动态表带来的高压缩率以"状态必须同步、连接错误必须整体重建"为代价；QUIC 用 QPACK 以流级独立压缩规避。
4. **逐跳流控换内存可控**：流控只作用于单跳，端到端仍靠应用层背压；但每跳可限制窗口，避免单条流耗尽接收缓冲。
5. **优先级复杂但可选**：规范的依赖树 + 权重表达力强，但实现复杂、易形成环；nghttp2 与 nginx 的实现取舍不同（nghttp2 完整实现树，nginx 早期只支持权重）。
6. **服务器推送（PUSH_PROMISE）**：表达力强但缓存耦合、易被滥用，主流浏览器后续关闭了该能力；nghttp2 仍完整实现。

## 不变量

1. 同一连接上，已分配的流 ID 单调递增；对端收到的新流 ID 必须大于其见过的最大的同方向 ID。
2. 帧头 Length 不超过对端 SETTINGS_MAX_FRAME_SIZE（默认 16384）。
3. 发送侧：任何时刻，连接未确认数据量 ≤ 连接窗口 且 每个流的未确认数据量 ≤ 对应流窗口。
4. 流窗口与连接窗口的未确认增量只增不减（窗口不被负向调整；仅 SETTINGS_INITIAL_WINDOW_SIZE 可批量改）。
5. HPACK 动态表容量 ≤ 对端 `SETTINGS_HEADER_TABLE_SIZE`，且解码器表状态始终与编码器同步。
6. 半关闭（half-closed）流：一端发 END_STREAM 后，该方向不再发 DATA；连接只在所有流关闭或收到 GOAWAY 后关闭。
7. RST_STREAM 之后的流立即进入关闭路径，不再接受该流的后续 DATA/HEADERS。

## 边界条件与异常处理

| 条件 | 处理 | 对应源码 |
| --- | --- | --- |
| 收到流 ID ≤ 已用 ID 或超 2^31-1 的新流 | PROTOCOL_ERROR（连接错误） | `nghttp2_session_recv()` 中流 ID 校验 |
| DATA 帧超窗 / WINDOW_UPDATE 增量为 0 / 增量致窗口溢出 | FLOW_CONTROL_ERROR（连接错误） | `nghttp2_session_*window*` 路径 |
| HEADERS 头块解码失败、动态表不同步 | COMPRESSION_ERROR（连接错误） | `nghttp2_hd_inflate_*` 返回错误传播 |
| 帧长度非法（超帧大小 / 特定类型 payload 长度不符） | FRAME_SIZE_ERROR | `nghttp2_frame_unpack_frame_hd()` 校验 |
| PUSH_PROMISE 而 SETTINGS_ENABLE_PUSH=0 | PROTOCOL_ERROR | `nghttp2_session_recv()` 分支 |
| 半关闭/关闭流上收到 DATA | STREAM_CLOSED 错误码，RST_STREAM | `nghttp2_session_close_stream()` |
| 对端发 RST_STREAM | 对应流立即终止，其他流继续 | `nghttp2_session_close_stream()` |
| 对端发 GOAWAY | 本端停止新流，处理完 last_stream_id 内已有流后关闭 | `nghttp2_session_terminate_session()` |
| 对端发 END_STREAM 后仍收到 DATA | PROTOCOL_ERROR | 流状态检查（half-closed(remote)） |
| 优先级依赖形成环 | PROTOCOL_ERROR 或按提示忽略 | 优先级处理路径 |
| 会话收到错误码帧自身 | 进入 terminate_session 路径，发 GOAWAY 后关闭 | `nghttp2_session_terminate_session_with_reason()` |