# RPC 与序列化 · src

## 上游版本

| 仓库 | tag | commit | 许可证 |
| --- | --- | --- | --- |
| github.com/grpc/grpc | **v1.60.2** | `0bab87ede8244a21fce01294a364cc9a7fc99ed8` | Apache-2.0（`LICENSES/LICENSE`） |
| github.com/protocolbuffers/protobuf | **v26.1** | `8536c48e19ca4e74c4fc6fc1235850eeabc8afac` | BSD-3-Clause（未复制，见下） |

commit 由 tag 解析取得；全部文件从 `raw.githubusercontent.com` 下载，未做任何改动。

## 文件清单（文件 → 类别 → 阅读范围）

`upstream/` 下文件保留上游相对路径。类别按设计文档 §3：core = 协议本身、integration = 与其他协议/系统连接、platform = 系统/平台适配。

| 文件（upstream/ 下） | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/core/lib/surface/call.cc` | core | 全文。RPC call 核心：创建（`FilterStackCall::Create`）、批处理（`StartBatch`/`ExecuteBatch`）、deadline（`send_deadline_`、`InitParent` 传播）、取消（`grpc_call_cancel_with_status`、`CancelState`）、初始/结尾 metadata（`ProcessIncomingInitialMetadata`、`PublishToAppEncoder`） |
| `src/core/lib/surface/channel.cc` | core | 全文。channel 的 surface 实现：`Channel::CreateWithBuilder`/`Create`、`RegisterCall`/`RegisteredCall`、`UpdateCallSizeEstimate`、`grpc_channel_reset_connect_backoff`、`grpc_channel_destroy` |
| `src/core/lib/surface/server.cc` | core | 全文。服务端：`grpc_server_create`、`grpc_server_register_method`、`grpc_server_start`、`grpc_server_cancel_all_calls`、`RequestMatcher*`（method 匹配）、completion queue 出口（`grpc_cq_end_op`） |
| `src/core/lib/transport/transport.cc` | integration | 全文。传输抽象：stream 引用计数（`grpc_stream_ref_init`/`grpc_stream_destroy`）、传输批操作（`grpc_transport_stream_op_batch_*` 及其 failure 变体）、stream 统计迁移（`grpc_transport_move_*_stats`）。调用 HTTP/2 层（未复制） |
| `src/core/lib/slice/slice.cc` | core | 全文。字节缓冲：`grpc_slice_from_copied_buffer`/`_moved_*`、`grpc_slice_malloc(_large)`、`grpc_slice_sub`、`grpc_slice_split_head/tail`、refcount 族类（`NewSliceRefcount` 等） |
| `src/core/lib/gprpp/ref_counted_ptr.h` | platform | 全文。泛型引用计数智能指针 `RefCountedPtr<T>`，channel/call 的引用管理基础 |
| `src/google/protobuf/wire_format.cc` | core | 全文。protobuf wire 编码：varint/tag/length、嵌套消息、`InternalSerialize*` 系列、`Parser` 状态机（`kNoTag/kHasType/kHasPayload/kDone`）、map 序列化与键排序 |

未复制但可感知的依赖：gRPC core 的 HTTP/2 帧引擎（`src/core/lib/http2/`）、event engine（`src/core/lib/event_engine/`）、name resolver、TLS 集成、completion queue 内部、`metadata_batch.h`、`call_finalization.h` 等，均在调用链中表现为调用或 include，本模块以文档描述其职责，不复制。

## 阅读顺序与调用链

按「一条从输入到输出的真实闭环」组织：**protobuf 编码 → call 创建 → 批操作 → transport → stream 生命周期 → server 分发**。

```text
[protobuf] wire_format.cc
    InternalSerialize* / Parser         请求/响应消息 ↔ 字节

[gRPC core: 客户端侧]
    surface/channel.cc
        Channel::CreateWithBuilder / Create    建立 channel（目标 authority）
        Channel::RegisterCall                  预注册 method（registered call）
    surface/call.cc
        FilterStackCall::Create                创建 call（idle）
        StartBatch → ExecuteBatch              请求编码 + 提交传输批操作
        ProcessIncomingInitialMetadata         校验入站初始 metadata
        grpc_call_cancel_with_status           取消（异常路径）

[传输层]
    transport/transport.cc
        grpc_stream_ref_init                   建立 stream（引用计数）
        grpc_transport_stream_op_batch_*       向 HTTP/2 层提交批操作
        grpc_stream_destroy                    引用归零后销毁

[缓冲]
    slice/slice.cc
        grpc_slice_from_copied_buffer          构造 payload slice
        grpc_slice_sub / split_*               零拷贝切片
        grpc_slice_malloc                      分配

[gRPC core: 服务端侧]
    surface/server.cc
        grpc_server_create                     创建 server
        grpc_server_register_method            注册 method
        RequestMatcher*                        请求 → handler 匹配
        grpc_cq_end_op                         结果经 completion queue 回传
        grpc_server_cancel_all_calls           关闭时取消全部在途 call

[支撑]
    gprpp/ref_counted_ptr.h                    引用计数所有权基础
```

## 入口函数 / 结束函数

| 层 | 入口 | 结束 |
| --- | --- | --- |
| 客户端 RPC | `FilterStackCall::Create`（call.cc）→ `StartBatch` | `grpc_call_unref`（引用归零） |
| 传输 | `grpc_transport_stream_op_batch_*`（transport.cc） | `grpc_stream_destroy`（refcount=0） |
| 服务端 | `grpc_server_create` / `grpc_server_register_method`（server.cc） | `grpc_server_shutdown_and_notify` / `grpc_server_cancel_all_calls` |
| 缓冲 | `grpc_slice_from_copied_buffer` 等构造器 | refcount 归零自动释放 |

## 未复制的依赖

| 依赖 | 上游路径（v1.60.2） | 职责 |
| --- | --- | --- |
| HTTP/2 帧引擎 | `src/core/lib/http2/` | 帧编解码、stream 状态机、flow control、RST_STREAM；gRPC 传输的前提 |
| event engine | `src/core/lib/event_engine/` | 异步执行、线程调度（transport.cc 中 `ExecCtx::Run`） |
| name resolver | `src/core/lib/event_engine/ares_resolver.*` 等 | 目标地址解析（DNS/custom），服务发现的挂钩点 |
| TLS 集成 | gRPC TLS 模块 | 认证与加密（h2），归 TLS 模块阅读 |
| completion queue 内部 | `src/core/lib/surface/completion_queue*.cc` | 服务端结果异步出口的实现细节 |
| metadata 定义 | `src/core/lib/transport/metadata_batch.h` | metadata 键值批的实体类型（call.cc 仅使用接口） |
| slice 内部 | `src/core/lib/slice/slice_internal.h` 等 | slice 内部细节 |
| call 终结回调 | `src/core/lib/channel/call_finalization.h` | call 终结钩子 |
| protobuf `LICENSE` | 仓库根 `LICENSE`（BSD-3-Clause） | 许可证文本，未复制 |

## 已复制 / 跳过说明

- **已复制（7 文件 + 1 许可证）**：见上方清单与 `LICENSES/`。
- **channel.cc 路径调整**：设计文档建议的 `src/core/lib/channel/channel.cc` 在该版本不存在，实际复制 `src/core/lib/surface/channel.cc`（channel 的 surface 入口），详见 `references.md` 阅读备注。
- **protobuf 许可证未复制**：为避免多份许可证歧义，仅复制 gRPC 的 `LICENSE`（Apache-2.0，为 call/channel/server 等主源码的许可依据）；protobuf 的 BSD-3-Clause 许可证文本未下载，记录于 `references.md`，如需补充可再下载。
- **未添加任何补丁**：全部文件原样保存；学习注释可在 `upstream/` 副本上直接追加（格式见根设计文档 §3），不改变控制流。