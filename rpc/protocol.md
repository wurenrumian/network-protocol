# RPC 与序列化 · protocol

## 问题定义

### 跨进程调用

RPC（Remote Procedure Call）要解决的问题是：让一段代码像调用本地函数一样调用位于另一个进程（通常是另一台机器）里的过程。与本地调用的差异是本质性的：

- **地址不可直接寻址**：被调函数在远端，需要把「方法 + 目标」编码为可寻址的 wire 上的名字（gRPC 中是 `host + method`）。
- **数据必须穿越网络**：参数与返回值必须序列化为字节流，接收端再反序列化；这个「穿过边界」的过程引入了本地调用没有的容量、编码与版本问题。
- **一次调用可能永远没有结果**：网络会丢包、对端可能崩溃、延迟不可预测。调用方必须定义「多久算失败」（deadline）以及「失败后怎么办」（重试/取消）。
- **错误不只是异常**：除了业务异常，还有传输错误、超时、对端拒绝、流中断等不同语义的错误，需要统一的错误模型。
- **每个调用都有副作用风险**：一次请求可能已被对端执行而响应丢失，重发会重复执行；这正是幂等/去重存在的理由。

### 接口契约

RPC 的双方必须预先共享一份「接口描述」：方法名、参数类型、返回类型、语义（是否幂等、是否流式）。这份契约有两种落法：

- **IDL（接口描述语言）**：gRPC 用 `.proto`（protobuf），Thrift 用 `.thrift`。编译期生成客户端 stub 与服务端骨架，双方从同一份 `.proto` 获得一致的请求/响应消息布局。
- **运行时自描述**：JSON-RPC 在报文中携带方法名与参数，无需编译期骨架，但类型信息在 wire 上，解析开销与歧义都更大。

契约的核心作用不是「自动生成代码」本身，而是让**编码（序列化）与寻址（method 名）**在双方之间有一个共同基准：客户端怎样把参数变成字节、服务端就必须按同一规则变回来；客户端调用 `/foo/Bar/baz`，服务端就必须注册过同一个方法名。

## 抽象对象

本节只描述 gRPC core（v1.60.2）用来表达上述问题的对象；实现文件见 `src/README.md`。

| 抽象 | 对应源码（v1.60.2） | 职责 |
| --- | --- | --- |
| **call** | `src/core/lib/surface/call.cc` | 一次 RPC 的全生命周期状态：创建、批处理执行、deadline、取消、初始/结尾 metadata、context 传播 |
| **channel** | `src/core/lib/surface/channel.cc`（surface API；内部 stack 拆分于 `src/core/lib/channel/`） | 对端地址的命名实体：负责建连、维护连接、为 call 提供 transport、注册预注册 call（registered call） |
| **server** | `src/core/lib/surface/server.cc` | 监听侧：注册 method → 请求到达时匹配（RequestMatcher）→ 分发给 handler → completion queue 回传结果 |
| **stream** | `src/core/lib/transport/transport.cc`（引用计数与批操作）；底层 HTTP/2 stream 由未复制的 `src/core/lib/http2/` 提供 | 单次 RPC 在传输上的载体：携带发送/接收方向的 op batch、one-way 统计（字节数、消息数） |
| **transport op / batch** | `transport.cc` 中 `grpc_transport_stream_op_batch_*` | 把「发数据」「发 metadata」「取消」等动作打包成一次性的批量操作提交给 transport |
| **metadata** | `src/core/lib/transport/metadata_batch.h`（未复制，见注释）；call.cc 中 `ProcessIncomingInitialMetadata` | 键值语义的带外数据（deadline、trace、pushback 等都通过 metadata 传递） |
| **deadline** | call.cc `send_deadline_` / `Timestamp`；metadata `GrpcTimeoutMetadata` | 绝对时间点，越过即失败；可从父 call 传播（`GRPC_PROPAGATE_DEADLINE`） |
| **buffer（slice）** | `src/core/lib/slice/slice.cc` | 引用计数的字节缓冲：零拷贝切片、分裂（split head/tail）、组合，避免 payload 在层间传递时反复复制 |
| **completion queue（CQ）** | server.cc 中 `grpc_cq_end_op`；未复制的 `src/core/lib/surface/completion_queue.cc` | 服务端结果异步回传的出口；tag 关联到对应请求 |

关系：`channel` 提供 `stream`，`stream` 承载 `call` 的 `batch`；`call` 的请求/响应字节以 `slice` 形式流过；`server` 在收到请求后同样建立一个 call 并交由 handler 处理，结果经 completion queue 回传。

## wire format

gRPC 的 wire 是两层封装，外加第三层（protobuf）做参数序列化：

```
[ HTTP/2 帧（含流 ID） ][ gRPC 帧（长度 + 标志 + 帧类型） ][ protobuf 消息（tag/varint 编码） ]
```

### HTTP/2 作为传输

- gRPC 规定传输承载为 HTTP/2（规范中为 `h2` / `h2c`），TLS 上为 `h2`（ALPN）。
- **流 ID（stream id）** 即 RPC 的「请求 ID」：每个 RPC 占用一个 HTTP/2 stream，请求与响应在同一 stream 上多路复用，因此多个并发调用共享一条连接而不互相阻塞（避免 HTTP/1.1 的队头阻塞）。
- 帧类型中，gRPC 客户端主要使用 HEADERS（发初始 metadata）、DATA（消息 payload）、RST_STREAM（取消/错误中断）与 PING/GOAWAY（连接级控制，未在复制文件内展开）。
- 连接级 flow control 与 stream 级 flow control 由 HTTP/2 层承担，gRPC 自身不再加窗。

### gRPC 帧封装

每个消息（一个 protobuf 编码的请求/响应/streaming chunk）在 wire 上被包成：

```
0                   1                   2                   3
0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| 压缩标志(1bit) | 保留(3bit) | 消息类型(4bit)   | 消息长度(4字节) |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- 1 字节前缀 + 4 字节大端长度：`compression flag | reserved | message type`，后接消息长度（不含前缀本身）。
- 消息类型在 gRPC 中取值 0（DATA）与 1（Trailers，用于结尾 metadata）。
- 头部随初始 metadata（HEADERS 帧）发送，其 `:path` 为 `/service/method`，即方法的寻址名字。

### protobuf wire 类型（varint / tag / length）

序列化层由 `src/google/protobuf/wire_format.cc` 实现。protobuf 编码的核心规则：

- **varint**：小端基 128 编码，每个字节 7 位有效负载 + 1 位继续标志，用于字段号、长度与整数。
- **tag**：每个字段以 `(field_number << 3) | wire_type` 的一个 varint 开头；wire type 取值：0 = varint、1 = 64-bit、2 = length-delimited（字符串/嵌套消息）、5 = 32-bit。解析器据此知道「跳过还是递归进下一个消息」。
- **length**：`length-delimited` 字段以 varint 长度开头，后接载荷；因此**解析可以跳过未知字段**，这正是前后向兼容性的来源——旧客户端能安全跳过新服务端新增的字段。
- 嵌套消息与 `packed repeated`（重复字段打包成一个 length-delimited 块）由 `InternalSerialize*` 系列与 `Parser` 状态机（`kNoTag / kHasType / kHasPayload / kDone`，见 wire_format.cc:639）处理。
- wire_format.cc 是「data-only」的编码实现（`MapValueRefDataOnlyByteSize` 等），不依赖具体生成的消息类，代表 protobuf 编码的纯机制部分。

## 核心机制

### 请求 / 响应

一次 unary（一问一答）RPC 在 wire 上的形态：

1. 客户端在一条 HTTP/2 stream 上发 HEADERS（初始 metadata，含 `:path`）→ 随后发一个 DATA 帧承载 protobuf 编码的请求消息。
2. 服务端返回 HEADERS（响应 metadata）→ DATA（protobuf 响应消息）→ 结尾 metadata（Trailers，含 `grpc-status`）。
3. 失败时以非零 `grpc-status` 表达，取消/中断用 RST_STREAM。

对应源码：call.cc 中请求的编码与发送集中在 `PublishToAppEncoder` 与批处理 `ExecuteBatch`；服务端匹配与分发在 server.cc 的 `RequestMatcherInterface`（v1.60.2 中为 Promise 风格实现）。

### streaming（unary / server / client / bidi）

- **unary**：客户端一个请求消息 → 服务端一个响应消息。
- **server streaming**：客户端一个请求 → 服务端多个消息（长列表、推送）。
- **client streaming**：客户端多个请求消息 → 服务端一个响应。
- **bidirectional streaming**：双方都可发多个消息，顺序独立（每个方向是独立的消息序列）。

所有流式形态共享同一传输机制：同一 HTTP/2 stream 上按方向排列多个 DATA 帧，每个 DATA 帧是一个 protobuf 消息；流的开/关由「半关闭」语义表达（客户端 `half-close` 表示请求消息发完，服务端 `half-close` 表示响应发完），结尾 metadata（Trailers）携带终态。call.cc 的批处理模型与 slice 缓冲使多条消息以同一 batch 流水通过，不需要为「流式」单独建新连接。

### deadline 与取消

- **deadline** 是绝对时间点（`Timestamp send_deadline_`，call.cc:247）。到达 deadline 而请求仍未完成，则调用以超时状态失败。
- deadline **沿调用树传播**：`InitParent(parent, propagation_mask)` 以 `GRPC_PROPAGATE_DEADLINE` 取父子 deadline 的较小者（call.cc:292-293），保证「父调用超时，子调用随之超时」的语义闭环。
- deadline 也可作为 metadata（`GrpcTimeoutMetadata`）随请求发往对端，使服务端在**自己的**计时器上也能响应超时，而不是只能依赖客户端端侧的等待。
- **取消**是显式的失败注入：`grpc_call_cancel_with_status` 使 call 以指定状态终止，向传输提交取消 batch，未发送数据不再发送，已收到的流以 RST_STREAM 中断。取消后的 call 状态迁移见 `state-machine.md`。

### 重试 / 幂等

- 网络失败后「是否重发同一个请求」取决于该请求的幂等性：幂等方法（如查询、覆写型写）可安全重试；非幂等方法重试会重复副作用。
- gRPC 的方法语义由 IDL 中的 `idempotency_level` 声明（NO_SIDE_EFFECTS / IDEMPOTENT），客户端据此决定自动重试的合法性。
- 重试受 deadline 约束：重试累计的等待时间不能超过 deadline，避免「重试反而放大了不可用」。
- **pushback** 是重试的反向控制：服务端可用 `GrpcRetryPushbackMsMetadata`（call.cc:1149）明确告诉客户端「请推迟 N 毫秒再重试」，防止重试风暴。
- 协议层面 gRPC 本身不提供去重/至少一次保证，重试语义落在「方法幂等声明 + 客户端策略 + deadline 边界」的组合上。

### metadata

- metadata 是键值列表，随请求/响应初始与结尾阶段携带，承载协议控制信息与用户附加信息（`grpc-timeout`、`grpc-status`、trace id、auth 凭据等）。
- call.cc 区分初始 metadata 与结尾 metadata（Trailers）：初始 metadata 在 HEADERS 帧中发，结尾 metadata 在流尾发；`ProcessIncomingInitialMetadata` 对入站 metadata 做校验与修复（补压缩、保护关键字段）。
- metadata 与业务参数（protobuf 消息）是**两个通道**：参数走 DATA 帧，metadata 走 HEADERS/Trailers。

### 认证

- gRPC 认证不在其自有协议内实现，而是复用承载层与 metadata：
  - **TLS 层**：证书认证、mTLS 双向认证、ALPN 协商 h2。
  - **HTTP 层**：`authorization` metadata（如 Bearer token），随初始 metadata 发送。
  - **凭据不进入 protobuf 参数**，从而不被业务逻辑与日志误用。
- 服务端在 RequestMatcher/分发前可校验 `authorization` metadata；本模块未复制 TLS 相关源码，认证细节归 TLS 模块。

### 服务发现 / 负载均衡

- gRPC 协议本身不规定发现机制；生产上由 **gRPC name resolver + 负载均衡器** 组合：
  - 客户端把方法名解析为「scheme + authority」，由 resolver（DNS 或自定义 name resolver）得到一组可用端点。
  - channel 代表一个 authority；连接复用让多路调用共享少量连接。
  - 负载均衡策略（round-robin、最小连接等）位于 name resolver 或 LB 层，gRPC core 只保留「channel → 一组地址 → 建连」的抽象，便于上层注入策略。
- 本模块复制范围不含 resolver/LB 实现；`channel.cc` 中的 `is_internal_channel`、connect backoff（`grpc_channel_reset_connect_backoff`）是观察点。

## 设计取舍

### gRPC + protobuf vs Apache Thrift

| 维度 | gRPC + protobuf | Thrift |
| --- | --- | --- |
| 传输绑定 | 强制 HTTP/2（多路复用、flow control、TLS 现成） | 自己定义传输层，可跑多种底层（socket、HTTP、mem 等），但多路复用要自建 |
| 流 ID / 请求 ID | HTTP/2 stream id 天然提供 | 需要协议自己设计请求 ID 与多路复用 |
| 编解码 | protobuf：编译期 schema、紧凑 varint、可跳过未知字段 | Thrift 二进制/compact 协议：同样编译期 schema，字段 ID 显式 |
| 生态 | 官方丰富（stub 生成、interceptor、deadline 内置） | 语言覆盖广、控制更底层 |
| 调试性 | wire 较难直接肉眼解读 | 类似 |

核心取舍：gRPC 把「RPC 语义」建在成熟的 HTTP/2 之上，换取多路复用、流控、TLS 的免费；代价是传输层灵活性低、协议耦合 HTTP/2。Thrift 把序列化与传输分层解耦，代价是请求 ID、复用、超时都要自己定义。

### protobuf vs Cap'n Proto / FlatBuffers

- protobuf：**解析式**编码，wire 紧凑、schema 演进强（tag 编号 + 可跳过未知字段），但每次都要反序列化，CPU 有解析成本。
- Cap'n Proto / FlatBuffers：**零拷贝**，编码就是内存布局，读取无需解析；代价是格式耦合内存布局、对齐/字节序约束多、wire 尺寸更大。以「免解析」换「简洁与演进」是主要取舍。

### 完整性的取舍（本模块范围）

gRPC core 是大型 C++ 项目。本模块只保留能构成一条「接口描述 → 编码 → 传输 → 分发 → 响应」闭环的关键文件（见 `src/README.md`），未复制的部分（HTTP/2 帧引擎、resolver、TLS、completion queue 内部等）在文档中记录为依赖。这是「概念 + 关键文件」的学习粒度，不是可编译的完整实现。

## 不变量

1. **stream 与 call 一一对应**：一个 HTTP/2 stream 上同时至多承载一个 RPC call 的字节流；stream 的引用计数（`grpc_stream_refcount`）归零时才允许销毁（transport.cc:44 `grpc_stream_destroy`）。
2. **deadline 单调收紧**：父子 call 的 deadline 取较小者（call.cc:292-293），任何子调用都不会比父调用活得更久。
3. **slice 引用计数一致**：slice 只能通过 `grpc_slice_sub`/`split_*` 等显式操作生成视图，底层 buffer 引用计数归零即释放；不得在释放后访问（slice.cc 的 refcount 族类维护此不变量）。
4. **metadata 终态可判**：每个 call 以初始 metadata 开始、以结尾 metadata（Trailers）或取消终止；`grpc-status` 提供可判定的终态。
5. **batch 与 transport 生命周期一致**：传输批操作在 stream 存活期内提交，`grpc_transport_stream_op_batch_finish_with_failure` 保证失败也推进终态，不留悬挂 call。
6. **channel 归零释放**：channel 由 `RefCountedPtr` 管理（`ref_counted_ptr.h`），引用数归零才释放；`grpc_channel_destroy` 是显式销毁入口。

## 边界条件与异常处理

- **deadline 到达**：call 以超时状态终结；若此时请求尚未全部发出，未发部分作废；对端可能仍执行（非幂等方法），由幂等声明与重试策略承接。
- **对端过早结束（半关闭）**：对端发完请求消息后关闭发送方向，服务端据此判定请求消息集终结；若客户端在未发完前取消，服务端收到 RST_STREAM。
- **stream 中途失败**：任一方 RST_STREAM，批操作以失败完成（`..._finish_with_failure`），call 进入失败终态，slice 引用释放。
- **pushback 与重试**：服务端以 `GrpcRetryPushbackMsMetadata` 抑制客户端重试；重试窗口不得越过 deadline。
- **channel 连接失败 / 连接回落**：channel 维护 connect backoff（`grpc_channel_reset_connect_backoff`），注册的 call 在连接恢复后重试建立 transport。
- **未知 method / 未注册方法**：server 的 RequestMatcher 找不到匹配时，以未找到方法的状态拒绝该请求。
- **metadata 非法**：`ProcessIncomingInitialMetadata` 校验失败时拒绝请求，避免畸形 metadata 进入业务。
- **buffer 生命周期越界**：slice 拆分（`grpc_slice_split_tail`）在边界处返回正确长度的视图；对越界的 sub 请求视为错误输入。
- **server 关闭**：`grpc_server_shutdown_and_notify` / `grpc_server_cancel_all_calls` 主动终止全部在途 call，经 completion queue 通知调用方。