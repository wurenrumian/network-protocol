# HTTP/2 · state-machine

## 状态

### 流状态（RFC 7540 §5.1）

规范定义 **idle → open → half-closed / closed** 的生命周期。nghttp2 在 `lib/nghttp2_stream.h` 中以 `nghttp2_stream_state` 枚举内部状态（客户端与服务器视角不同）：

| nghttp2 状态 | 对应规范语义 | 说明 |
| --- | --- | --- |
| `NGHTTP2_STREAM_INITIAL` | idle | 流刚创建、尚未发送/接收任何帧 |
| `NGHTTP2_STREAM_OPENING` | open（发送请求 HEADERS 后，尚未收到响应） | 客户端发送请求 HEADERS 后；服务器收到请求 HEADERS 后（此时发响应 HEADERS 才进入 OPENED） |
| `NGHTTP2_STREAM_OPENED` | open | 双向都已开始，正常传输 DATA 的阶段 |
| `NGHTTP2_STREAM_CLOSING` | half-closed → closed 之间 | 已排队 RST_STREAM（或已收到 RST），等 RST 发出/确认后进入 CLOSED |
| `NGHTTP2_STREAM_RESERVED` | reserved(local/remote) | 收到/发出 PUSH_PROMISE 后、实际打开前的保留流 |
| `NGHTTP2_STREAM_CLOSED` | closed | 流结束，可被回收 |

规范意义上的 half-closed 在 nghttp2 中通过**方向标志**表达：`shut_rd` / `shut_wr`（见 `nghttp2_stream_shutdown()`），当收到对端 END_STREAM 置 `shut_rd`，发出 END_STREAM 置 `shut_wr`；两方向都关闭后流才真正结束。

### 会话（连接）状态

HTTP/2 协议本身没有显式连接状态机，nghttp2 会话生命周期可归纳为：

| 阶段 | 进入条件 | 退出条件 |
| --- | --- | --- |
| 初始化 | `nghttp2_session_client_new()` / `server_new()` | 完成参数填充、SETTINGS 默认值、流表与窗口初始化 |
| 活跃 | 连接建立后 | 收发帧、开流/关流、窗口更新持续进行 |
| 终止中 | `nghttp2_session_terminate_session()` 被调用或收到致命错误 | 排队并发送 GOAWAY，拒绝新流 |
| 关闭 | 所有流关闭、GOAWAY 处理完毕 | 资源释放（`session_del()`） |

会话不维护独立枚举，状态散落在 `nghttp2_session` 结构的字段上：`goaway_flags`、`local/remote_window_size`、`streams` 计数等。

### HPACK 编解码流程

HPACK 无协议状态机，而是**同步游标式处理**：

- **解码器（inflater）**：`nghttp2_hd_inflater` 持有 `nghttp2_hd_context`（动态表、索引空间）。`nghttp2_hd_inflate_hd()` 从输入缓冲区逐个解码头字段，内部记录已消费字节数；头块未读完时再次调用继续，直到 `nghttp2_hd_inflate_end_headers()`。
- **编码器（deflater）**：`nghttp2_hd_deflater` 同样持动态表。`nghttp2_hd_deflate_hd()` 把头字段序列编码进输出缓冲，按表容量维护 LRU。

动态表容量变更在 inflater/deflater 中各自处理：解码器通过 `nghttp2_hd_inflate_change_table_size()` 响应对端 SETTINGS；编码器通过 `nghttp2_hd_deflate_change_table_size()` 主动调整。

## 事件

| 事件 | 来源 | 主要影响 |
| --- | --- | --- |
| 客户端发送请求 HEADERS（含 END_STREAM） | 应用发起 | 新流 OPENING→OPENED；发送方向 shut_wr |
| 收到响应 HEADERS | 对端 | OPENING→OPENED；可能 END_STREAM（进 half-closed(remote)） |
| 收到/发送 DATA | 对端 / 应用 | 窗口递减、数据交付、收端消费 |
| 收到 END_STREAM | 对端 | 对应方向 shut；两方向都关 → closed |
| 发送/收到 RST_STREAM | 任一端 | 立即进入 CLOSING→CLOSED，流的未处理 DATA 丢弃 |
| 收到 PUSH_PROMISE | 对端 | 新建 reserved 流 |
| 收到/发送 WINDOW_UPDATE | 任一端 | 对应窗口增量，唤醒被阻塞的发送 |
| 收到 SETTINGS | 对端 | 更新协商参数（初始窗口、帧大小、头表大小） |
| 收到 GOAWAY / 致命错误 | 对端 / 本地 | 会话进入终止路径 |
| 连接窗口耗尽 | 本地 | 阻塞该连接上所有流的数据发送 |

## 状态转移

### 流：规范状态图（RFC 7540 §5.1）

```text
                 +--------+
       发请求HEADERS|        |收到请求HEADERS
     +------------>|  idle  |<------------+
     |             +--------+             |
     |  发响应HEADERS|        |收到响应HEADERS
     |  +-----------+        +-----------+  |
     |  | reserved |        | reserved  |  |
     |  | (local)  |        | (remote)  |  |
     |  +-----------+        +-----------+  |
     |       |                  |           |
     |   收到响应HEADERS     发响应HEADERS    |
     v       v                  v           v
     +------------------+  +------------------+
     |        open      |  |        open      |
     +------------------+  +------------------+
          |        |           |        |
      发送END_STREAM  接收END_STREAM  发送END_STREAM  接收END_STREAM
          |        |           |        |
          v        v           v        v
   +-----------+ +-----------+ +-----------+ +-----------+
   |half-closed| |half-closed| |half-closed| |half-closed|
   | (remote)  | | (local)   | | (local)   | | (remote)  |
   +-----------+ +-----------+ +-----------+ +-----------+
          |            |             |            |
          |    (对端也结束 / RST / 两者皆为 closed)
          v            v             v            v
        +------------------------------------------+
        |                 closed                   |
        +------------------------------------------+
```

要点：

- **idle**：任何一端发送 HEADERS（或在 PUSH_PROMISE 中被承诺）即离开 idle；
- **open**：双向均可发送；任一端发 END_STREAM 即进 half-closed（对本端 local、对端 remote 语义）；
- **half-closed(local)**：本端不再发数据，仍可收；
- **half-closed(remote)**：对端不再发数据，本端仍可发（如响应剩余部分）；
- **closed**：任一端发送 RST_STREAM 后立即进入；或两方向都 END_STREAM 后进入；
- 在 closed 流上继续发送帧是错误（除少数例外：PRIORITY、WINDOW_UPDATE、RST_STREAM）。

### nghttp2 内部对应

| 规范状态 | nghttp2 内部表示 | 关键函数 |
| --- | --- | --- |
| idle | 尚未创建的流 / `NGHTTP2_STREAM_INITIAL` | `nghttp2_session_open_stream()` 创建 |
| open | `NGHTTP2_STREAM_OPENED` | 双向 DATA 收发 |
| half-closed(local) | `shut_wr` 置位 | `nghttp2_stream_shutdown(stream, NGHTTP2_SHUT_WR)` |
| half-closed(remote) | `shut_rd` 置位 | 收到 END_STREAM 时置位 |
| closing | `NGHTTP2_STREAM_CLOSING` | RST_STREAM 已排队未发出 |
| closed | `NGHTTP2_STREAM_CLOSED` | `nghttp2_session_close_stream()` 后从 `session->streams` 移除 |

## 正常 / 异常时序

### 正常：客户端请求 → 服务器响应 → 关闭

```text
客户端                                    服务器
  |--- HEADERS (END_HEADERS, 无 END_STREAM) --->|   流打开
  |--- DATA (END_STREAM) --------------------->|   half-closed(local)
  |                                            |--- HEADERS (END_HEADERS) --->|
  |<--- DATA --------------------------------|                              |
  |<--- DATA (END_STREAM) --------------------|   双方 closed
```

### 异常：流错误

```text
客户端                    服务器
  |--- HEADERS(请求不存在的资源) --->|
  |<--- RST_STREAM (STREAM_REFUSED) -|
  |        （该流立即 closed，连接继续）|
  |--- HEADERS(下一个请求) ---------->|
```

### 异常：连接错误

```text
客户端                    服务器
  |--- 超窗 DATA 帧（FLOW_CONTROL_ERROR）---->|
  |                                            |  session_terminate
  |<--- GOAWAY (last_stream_id, 错误码) -------|
  |---- 连接关闭 -------------------------------|
```

## 处理流程（无显式状态机时）

**收到一帧的主路径**（对应 `nghttp2_session_recv()` → `nghttp2_session_mem_recv()` → `nghttp2_session_on_frame_received()`）：

1. 校验帧头（长度、类型、stream_id 归属，超帧大小 → FRAME_SIZE_ERROR）；
2. 按帧类型分派：DATA/HEADERS/PRIORITY/RST_STREAM/SETTINGS/PUSH_PROMISE/PING/GOAWAY/WINDOW_UPDATE；
3. 每类帧先做**连接级前置检查**（流 ID 是否可接受、流是否存在、窗口是否足够）；
4. 更新流状态（开流/关流/半关闭标记）与窗口（`nghttp2_session_update_*_window_size`）；
5. 交付给应用回调（`on_header`/`on_data_chunk_recv`/`on_request_recv` 等）；
6. 若消费数据则回补窗口（`nghttp2_session_consume()` → WINDOW_UPDATE）。

**发送一帧的主路径**（对应 `nghttp2_session_send()` → `nghttp2_session_mem_send_internal()` → `nghttp2_frame_pack_*`）：

1. 按优先级队列选流（`nghttp2_stream.c` 的 `stream_obq_*`）；
2. 应用流控限额（`nghttp2_session_enforce_flow_control_limits()`，取连接窗口与流窗口的最小值）；
3. 构造并打包帧（`nghttp2_frame_pack_frame_hd()` 及各类型 payload 打包）；
4. 递减窗口、出队、交给回调写 socket；
5. 窗口耗尽时阻塞该流/连接，等待 WINDOW_UPDATE 唤醒。