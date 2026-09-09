# RPC 与序列化

## 定位

本模块回答「跨进程调用如何被描述、编码、传输和可靠地完成」。核心问题是：调用双方如何就「接口签名、报文格式、错误语义、超时与取消、连接复用、安全」达成一致，让一次远程调用在行为上尽量接近一次本地调用。

模块沿「ONC RPC → JSON-RPC → Thrift → Protocol Buffers → gRPC → Cap'n Proto/FlatBuffers」的谱系展开，重点不在 RPC 语义的完整实现，而在几个贯穿所有 RPC 的设计问题：

- 接口描述（IDL）如何生成客户端/服务端骨架；
- 数据如何编码（自描述 vs 编译期描述、紧凑性、向前/向后兼容）；
- 请求如何寻址（method + host）、如何关联响应（流 ID，等价于请求 ID）；
- 连接如何被多个并发调用复用（HTTP/2 多路复用）；
- 半双工/全双工流如何表达 unary、server/client/bidi streaming；
- deadline 与取消如何跨进程传播；
- 在「至少一次」与「最多一次」之间，重试与幂等如何取舍。

主实现为 **gRPC core（C++）+ Protocol Buffers**；Apache Thrift、Cap'n Proto 作为对照实现，用于比较「同一问题、不同取舍」。

## 前置模块

按协议学习主干（§4）的依赖关系：

- **HTTP/2**：gRPC 建立在 HTTP/2 之上，帧、流、多路复用、flow control 是本模块的传输前提。若尚未阅读，建议先完成 nghttp2 模块。
- **TLS**：gRPC 默认以 TLS 承载（h2 + TLS），认证与加密复用 TLS 的证书与握手机制。
- **TCP**：连接复用与流控的下层基础；deadline、重试最终作用于 TCP 之上的逻辑请求。
- **协议抽象与报文编码**（§4.1）：长度、边界、字节序、TLV 等分析语言在本模块直接复用（protobuf varint、frame header、metadata 编码）。

## 推荐阅读顺序

1. **protocol.md** —— 先建立问题模型与抽象对象：call、channel、stream、metadata、deadline、buffer，以及 wire format 的两层封装（HTTP/2 + gRPC 帧 + protobuf 消息）。
2. **state-machine.md** —— 再理解 gRPC call 从创建到结束的生命周期：idle → connect → ready → transmit → done，以及取消与 streaming 的生命周期。
3. **protobuf wire 编码** —— `src/upstream/src/google/protobuf/wire_format.cc`：varint、tag、length、嵌套消息的解析与构造，回答「数据到底怎么变成字节」。
4. **gRPC call 核心** —— `src/upstream/src/core/lib/surface/call.cc`：请求对象、批处理（batch）模型、deadline 传播、取消、初始 metadata 处理。这是整条闭环的中枢。
5. **channel 与 server** —— `src/upstream/src/core/lib/surface/channel.cc`（创建与注册 call）、`server.cc`（method 注册、请求分发、cancel all）。
6. **transport 与 slice** —— `transport.cc`（stream 引用计数、传输批操作、统计迁移）、`slice.cc`（零拷贝字节缓冲）。
7. **references.md** —— 回看规范文档、固定版本与 commit、对照实现，补足取舍视角。

源码导航以 `src/README.md` 为准，含文件清单、阅读顺序与调用链。

## 源码入口

- `src/upstream/src/core/lib/surface/call.cc` —— `FilterStackCall::Create()`（call 创建）、`StartBatch()` / `ExecuteBatch()`（一次 RPC 的输入输出闭环）、`grpc_call_cancel_with_status`（取消）。
- `src/upstream/src/core/lib/surface/channel.cc` —— `Channel::CreateWithBuilder()` / `Channel::Create()`、`Channel::RegisterCall()`。
- `src/upstream/src/core/lib/surface/server.cc` —— `grpc_server_create()`、`grpc_server_register_method()`、`grpc_server_start()`、`grpc_server_cancel_all_calls()`。
- `src/upstream/src/core/lib/transport/transport.cc` —— `grpc_transport_stream_op_batch_*`（传输层批操作）、`grpc_stream_ref_init()` / `grpc_stream_destroy()`。
- `src/upstream/src/core/lib/slice/slice.cc` —— `grpc_slice_from_copied_buffer()`、`grpc_slice_sub()`、`grpc_slice_split_tail()`。
- `src/upstream/src/google/protobuf/wire_format.cc` —— `InternalSerialize*` 与 `Parser`（wire 编码/解码）。

完整调用链见 `src/README.md`「阅读顺序与调用链」。

## 主实现 / 对照实现

| 角色 | 实现 | 作用 |
| --- | --- | --- |
| 主实现（RPC 语义） | gRPC core（C++），tag v1.60.2 | call/channel/server/transport/slice 抽象 |
| 主实现（序列化） | protobuf，tag v26.1 | wire_format.cc：varint/tag/length 编码 |
| 对照（RPC 与序列化一体） | Apache Thrift | 二进制协议 + IDL + 传输分层的另一种组合 |
| 对照（零拷贝、无解析） | Cap'n Proto | 以“编码即内存布局”规避解析的取舍 |

选型依据见 `protocol-learning-design.md` §4.0 / §4.6。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。本模块结构：

```text
rpc/
├── README.md          # 本文件
├── protocol.md        # 问题定义、抽象对象、wire format、核心机制、取舍、不变量、边界
├── state-machine.md   # call 状态机、streaming 生命周期
├── references.md      # 规范、仓库、固定版本/commit、对照实现、阅读备注
└── src/
    ├── LICENSES/      # 上游许可证（gRPC Apache-2.0 LICENSE）
    ├── upstream/      # 选定版本的 gRPC / protobuf 关键源文件（保留上游相对路径）
    └── README.md      # 文件清单、阅读顺序、调用链、裁剪说明
```