# RPC 与序列化 · state-machine

本文件描述 gRPC call 的状态流转与 streaming 生命周期。gRPC core 未给 call 定义「枚举状态」，而是以 `call stack` 元素 + 批操作 + 引用计数隐式表达生命周期；因此这里的状态是**观察模型**，用于对照源码中对应的事件与函数。

## 状态

| 状态 | 含义 | 对应源码（v1.60.2） |
| --- | --- | --- |
| idle | call 已创建但尚未提交任何批操作；未在 wire 上产生字节 | `FilterStackCall::Create()`（call.cc:792）之后、`StartBatch` 之前 |
| connecting | channel 尚未有可用连接，call 等待 transport 就绪（connect backoff / 排队） | channel.cc `CreateWithBuilder` / `grpc_channel_reset_connect_backoff`；批操作排队于 transport.cc `grpc_transport_stream_op_batch_*` |
| ready | transport 就绪，stream 建立；call 可以发送/接收 | stream 引用计数初始化（transport.cc:71 `grpc_stream_ref_init`） |
| transmitting | 请求/响应消息经批操作实际发送或接收中；发送 deadline 约束此阶段 | `ExecuteBatch`（call.cc:988）、`PublishToAppEncoder`（call.cc:1120） |
| done | 成功完成（收到响应 + 结尾 metadata）或失败（状态错误 / deadline / 取消 / 传输中断） | `grpc_transport_stream_op_batch_finish_with_failure`、`final_info_`（call.cc:738） |
| cancelled | 取消是 done 的一种：`grpc_call_cancel_with_status` 显式终止，未发数据作废 | `CancelState`（call.cc:1009） |

## 事件

| 事件 | 触发条件 | 产生效果 |
| --- | --- | --- |
| `Create` | 客户端发起 RPC / 服务端收到请求建立 call | 从 idle → 等待批操作；初始化 deadline、context 传播 |
| `StartBatch(ops, nops)` | 提交一组 op（发请求、发 metadata、取消、发流消息） | 校验与编码，进入 transmitting；batch 挂到 call 的 active batch 槽（`kMaxConcurrentBatches = 6`，call.cc:161） |
| `ExecuteBatch` | transport 就绪 | 把批操作提交给 transport；沿 stream 发送 slice |
| 响应到达 | 对端 DATA / Trailers | 解码；done（成功）或推进失败状态 |
| deadline 到达 | `send_deadline_` 超时 | 以超时状态失败 → done(failure) |
| `grpc_call_cancel_with_status` | 应用取消 | 注入取消 batch → done(cancelled) |
| 传输错误 / RST_STREAM | 对端中断、连接失败 | `..._finish_with_failure` → done(failure) |
| `Unref` | 引用计数归零 | 物理销毁（`grpc_call_unref`） |

## 状态转移

正常路径（客户端视角）：

```
idle ──Create──▶ waiting-for-batch
      ──StartBatch──▶ transmitting ──响应+Trailers──▶ done(success)
```

异常路径：

```
transmitting ──deadline 到──▶ done(timeout)
transmitting ──cancel_with_status──▶ done(cancelled)
transmitting ──传输错误/RST_STREAM──▶ done(failure)
connecting ──connect 失败──▶ backoff ──重试──▶ connecting / done(timeout)
```

不变量驱动的规则：

- **deadline 单调收紧**：`InitParent` 取父子 deadline 较小者（call.cc:292-293），因此任何状态下子 call 的 deadline 都不会晚于父 call；父超时必然触发子超时。
- **每个状态都必须能到达 done**：所有失败路径都收敛到 `finish_with_failure` 或取消，不留悬挂 call；`Unref` 前必须已 done 或已取消。
- **batch 串行推进**：同一时刻最多 `kMaxConcurrentBatches` 个批操作在途（call.cc:161），超出则排队，保证 stream 上的字节顺序不被打乱。

## 正常 / 异常时序

### 正常 unary 时序

```
客户端                         服务端
  │ Create(); StartBatch(发请求)  │
  │──────────────────────────────▶│ 收到 HEADERS + DATA
  │                               │ 建立 call；RequestMatcher 匹配 method
  │                               │ handler 执行；结果经 completion queue
  │◀──────────────────────────────│ 响应 metadata + DATA + Trailers(grpc-status)
  │ done(success)                 │
```

### 取消时序

```
客户端                                    服务端
  │ StartBatch(请求)                        │
  │──────────────────────────────▶          │
  │ grpc_call_cancel_with_status            │
  │ 未发数据作废；提交取消 batch             │
  │──────────── RST_STREAM ───────────────▶ │ 收到中断；call 以失败终态
  │ done(cancelled)                         │
```

### 超时时序

```
客户端                                   服务端
  │ StartBatch(请求, deadline=T)             │
  │──────────────────────────────▶           │
  │ (服务端处理超过 T)                        │
  │ deadline 到 → done(timeout)              │
  │ 若请求带 grpc-timeout metadata：          │
  │   服务端自己计时，主动以超时终止           │
```

### 重试时序（幂等方法）

```
请求失败(非终态错误)
  → 检查幂等声明 + deadline 余量
  → 若可重试：等待(受 pushback 约束) → 重新 Create 或复用 channel 再发
  → 若 pushback 返回 GrpcRetryPushbackMsMetadata：推迟 ≥ pushback 再重试
  → 累计时间越过 deadline → 以超时终止，不再重试
```

## 处理流程（无显式状态机时）

### streaming 生命周期

streaming 不引入新状态，而是在 `transmitting` 状态下按方向排列多个消息：

- **unary**：请求方向 1 消息 → 响应方向 1 消息 → Trailers。
- **server streaming**：请求方向 1 消息，客户端**半关闭**请求方向；服务端发 N 个消息后半关闭响应方向 → Trailers。
- **client streaming**：客户端发 N 个请求消息后半关闭；服务端 1 个响应 → Trailers。
- **bidi streaming**：双方各自按方向发 N 个消息，各自半关闭；两个方向独立关闭。

生命周期规则：消息按**方向**有序（同一方向的 DATA 顺序即业务顺序）；方向的终结由半关闭表达；call 的终结由双方都半关闭后的 Trailers（或任一方取消/RST_STREAM）决定。

### batch 驱动（源码角度的「状态机」）

真正驱动 call 推进的是批操作，而非显式状态：

1. `StartBatch`（call.cc:540）把应用动作翻译为 `grpc_op` 数组；
2. `ExecuteBatch`（call.cc:988）把 batch 提交给 transport 的 stream op batch（transport.cc:127 起）；
3. transport 完成（成功或 `finish_with_failure`）回调 call；
4. 响应解码、deadline 检查、取消检查都在回调路径上完成；
5. 引用计数（call 与 stream 双侧）归零后物理销毁。

以这条「Create → StartBatch → ExecuteBatch → transport 完成 → 终态」为主干，配合 `state-machine` 中的转移图，即可覆盖 gRPC call 的完整生命周期。