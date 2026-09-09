# TLS · state-machine

> 本文覆盖两块状态逻辑：握手状态机（TLS1.2 与 TLS1.3 的 client/server 状态流转）与 record 层处理流程。两者同属一条输入驱动链：`ssl_run_handshake` 循环解析「等待条件」→ 驱动握手状态机 → record 层解码对端数据并喂给握手层。主实现为 BoringSSL，对应 `src/upstream/ssl/handshake*.cc` 与 `tls_record.cc`。

## 状态

### 握手状态机的两层状态

握手状态机由**状态（state）**与**等待条件（wait）**两层组成，分层清晰：

- **外层：`enum ssl_client_hs_state_t` / `enum tls12_server_hs_state_t`**（定义于 `handshake_client.cc:46` / `handshake_server.cc`）。这是每个 `do_*` 函数之间的转移目标，驱动函数 `ssl_client_handshake` / `ssl_server_handshake` 用 `switch (hs->state)` 分发到对应 `do_*` 函数。
- **内层：`enum ssl_hs_wait_t`**（定义于 `ssl/internal.h`，未复制）。`do_*` 函数返回它，表示**当前握手被什么阻塞**：读消息（`ssl_hs_read_message` / `ssl_hs_read_server_hello` / `ssl_hs_read_change_cipher_spec` / `ssl_hs_read_end_of_early_data`）、刷写出（`ssl_hs_flush`）、异步回调（`ssl_hs_x509_lookup`、`ssl_hs_private_key_operation`、`ssl_hs_pending_session`、`ssl_hs_pending_ticket`、`ssl_hs_certificate_verify`）、以及完成/失败（`ssl_hs_ok` / `ssl_hs_error`）。

两者关系：**state 决定「下一步做什么」，wait 决定「下一步是否被卡住」**。`ssl_run_handshake`（`handshake.cc:526`）每轮先解析 `hs->wait`，再调用 `ssl->do_handshake` 让状态机跑一圈。

### TLS1.2 客户端状态（`handshake_client.cc:46` 枚举）

```text
start_connect
  → enter_early_data（仅 0-RTT）
  → early_reverify_server_certificate（仅 0-RTT）
  → read_server_hello
  → read_server_certificate / read_certificate_status(OCSP)
  → verify_server_certificate / reverify_server_certificate
  → read_server_key_exchange
  → read_certificate_request（可选）
  → read_server_hello_done
  → send_client_certificate（可选）/ send_client_key_exchange
  → send_client_certificate_verify（可选）
  → send_client_finished
  → finish_flight
  → read_session_ticket / process_change_cipher_spec
  → read_server_finished
  → finish_client_handshake
  → done
```

### TLS1.2 服务端状态（`handshake_server.cc` 枚举）

```text
start_accept
  → read_client_hello → read_client_hello_after_ech
  → cert_callback（选择凭证）
  → select_parameters（协商版本/套件/群）
  → send_server_hello
  → send_server_certificate / send_server_key_exchange / send_server_hello_done
  → read_client_certificate（可选）→ verify_client_certificate
  → read_client_key_exchange
  → read_client_certificate_verify（可选）
  → read_change_cipher_spec → process_change_cipher_spec
  → read_next_proto / read_channel_id（可选）
  → read_client_finished
  → send_server_finished（可选带 NewSessionTicket）
  → finish_server_handshake
  → done
```

### TLS1.3：握手并入 `state_tls13` / `state12_tls13`

TLS1.3 没有独立的顶层状态序列，而是收敛为**一个转移目标**：客户端 `do_tls13`（`handshake_client.cc:798`）与服务端 `do_tls13`（`handshake_server.cc:643`），内部转调 `tls13_client_handshake` / `tls13_server_handshake`（子状态机位于 `tls13_*.cc`，未复制，见 `references.md`）。拓扑判断：客户端在收到 ServerHello 后依 `ssl_protocol_version(ssl) >= TLS1_3_VERSION` 跳入 `state_tls13`；服务端在 `do_select_parameters` 协商出版本后跳入 `state12_tls13`。TLS1.3 握手子状态机覆盖：`ServerHello` → `EncryptedExtensions` → `Certificate*` → `CertificateVerify` → `Finished`（服务端），以及 `Finished` →（0-RTT 时 `EndOfEarlyData`）→ 应用数据（客户端）。

## 事件

驱动状态机前进的事件分四类，全部以 `enum ssl_hs_wait_t` 的返回值/等待条件体现：

1. **读事件**：对端握手消息到达且解析成功（`ssl_hs_read_message` 分支调用 `ssl_open_handshake` / `ssl_open_change_cipher_spec`，`handshake.cc:557` 附近）。Finish 类消息由 `ssl_get_finished`（`handshake.cc:394`）统一处理。
2. **写事件**：本端把整段 flight 刷入 BIO（`ssl_hs_flush` → `ssl->method->flush`，`handshake.cc:549`；`finish_flight` 由 `ssl_run_handshake:702` 隐式触发）。
3. **异步回调完成**：证书选择、私钥操作、会话/ticket 回调返回（`ssl_hs_x509_lookup` 等分支把 `hs->wait` 清为 `ssl_hs_ok` 以便下次重入，`handshake.cc:640` 附近）。这是与事件循环集成（integration）的切出点。
4. **应用调用重入**：外部调用 `SSL_do_handshake` 等（未复制）再次进入 `ssl_run_handshake`，继续解析等待条件。

消息顺序错误本身不构成事件，而是触发错误路径（见下）。

## 状态转移

### 转移机制

- **显式赋值**：绝大多数转移是 `do_*` 函数末尾 `hs->state = state_xxx`，如 `do_start_accept` 直接推进到 `state12_read_client_hello`（`handshake_server.cc:216`）。
- **闭环驱动**：`ssl_client_handshake` / `ssl_server_handshake` 用 `while (hs->state != done)` 循环，每次 `do_*` 返回非 `ssl_hs_ok` 就退出返回 wait；返回 `ssl_hs_ok` 则继续下一状态。`state_done` / `state12_done` 是唯一终止态。
- **子状态机委托**：TLS1.3 子状态机推进时会把顶层状态留在 `state_tls13`，待其返回 `ssl_hs_ok` 后顶层才继续。
- **等待-恢复**：任何等待条件把控制权交回 `ssl_run_handshake`，后者解析后再次调用 `ssl->do_handshake`；`do_handshake` 依据 `hs->state` 直接进入对应 `do_*`（不重做前置状态），实现断点续行。

### 协议版本分流（关键转移）

- **客户端**：`do_read_server_hello`（`handshake_client.cc:547`）解析 ServerHello 后，若协商出 TLS1.3 则 `hs->state = state_tls13`，否则沿 TLS1.2 状态序列继续。
- **服务端**：`do_select_parameters`（`handshake_server.cc:653`）选定版本后，TLS1.3 跳 `state12_tls13`；TLS1.2 跳 `state12_send_server_hello`。
- **会话恢复分流**：服务端 `do_read_client_hello` 中调用 `ssl_get_prev_session`（`handshake_server.cc:719`）匹配 session ticket / session ID；命中则跳 `state12_send_server_hello`（短握手），未命中走完整握手；TLS1.3 的 PSK 恢复在 `tls13_server_handshake` 内部完成。

### TLS1.2 vs TLS1.3 转移差异小结

| 维度 | TLS1.2 | TLS1.3 |
| --- | --- | --- |
| 状态组织 | 顶层完整状态序列 | 顶层收敛为单一 `state_tls13` 子状态机 |
| 密钥交换 | `ServerKeyExchange`/`ClientKeyExchange` + `ChangeCipherSpec` 切换加密 | 内置 ECDHE/PSK，无 CCS（仅兼容跳过），密钥由 key schedule 阶段性推进 |
| Finished | 无 transcript 绑定强度弱 | Finished 绑定整个 transcript（`ssl_get_finished` 校验 MAC 后 `ssl_hash_message`） |
| 恢复 | session ID / ticket | PSK 扩展，可叠加 0-RTT |

## 正常 / 异常时序

### 正常时序

**TLS1.3 全握手（1-RTT）**：

```text
Client                              Server
  |----- ClientHello -------------------->|
  |<---- ServerHello ---------------------|
  |<---- {EncryptedExtensions} -----------|  加密从 ServerHello 起逐步启用
  |<---- {Certificate} -------------------|
  |<---- {CertificateVerify} -------------|
  |<---- {Finished} ----------------------|
  |----- {Finished} --------------------->|  应用流量密钥双向启用
  |=====  application_data (双向)  ========|
```

**TLS1.3 恢复（PSK，0-RTT 或 1-RTT）**：客户端 ClientHello 携带 `pre_shared_key` + `psk_key_exchange_modes`（可加 `early_data`）；服务端若接受，ServerHello 确认 PSK，握手缩短为两条消息即可出应用数据。

**TLS1.2 全握手（2-RTT）**：

```text
Client                                 Server
  |-- ClientHello ------------------------>|
  |<-- ServerHello ------------------------|
  |<-- Certificate ------------------------|
  |<-- ServerKeyExchange ------------------|
  |<-- ServerHelloDone --------------------|
  |-- ClientKeyExchange ------------------>|
  |-- [CertificateVerify] -----------------|
  |-- ChangeCipherSpec / Finished -------->|
  |<-- ChangeCipherSpec / Finished --------|
  |=====  application_data (双向)  =========|
```

### 异常时序

- **协商失败**：无共同版本/套件/群 → 服务端 `do_select_parameters` 发 `handshake_failure` 警报，返回 `ssl_hs_error`（`handshake_server.cc:705`）。
- **证书验证失败**：客户端 `do_verify_server_certificate` 调用 `ssl_verify_peer_cert`，验证非 OK 则发 `bad_certificate` 类警报并终止。
- **Finished 校验失败**：`ssl_get_finished` 对 peer Finished 与本地 transcript 计算值不等时，发 `decrypt_error` 并返回 `ssl_hs_error`（`handshake.cc:418`）。
- **消息类型错误**：`ssl_check_message_type` 发现类型不符 → `unexpected_message` 警报（`handshake.cc:115`）。
- **0-RTT 被拒绝**：服务端 `state12_read_client_hello_after_ech` 设 `skip_early_data`，客户端收到拒绝后回退全握手（`ssl_hs_early_data_rejected` 分支）。
- **ECH 拒绝**：`do_finish_client_handshake` 中若 `ech_status == ssl_ech_rejected` 发 `ech_required` 并终止（`handshake_client.cc:1771`）。
- **重协商（renegotiation）**：初始握手完成后再次进入 `ssl_client_handshake`，`do_start_connect` 重置 `session_reused`（`handshake_client.cc:323`），不携带会话恢复。

## 处理流程（无显式状态机时）— record 层

record 层不是标准状态机，但遵循固定的**读入→头校验→载荷→解密→类型分发**流水，等价于三态循环：`等待头` → `等待载荷` → `解密校验`。输入为 TCP 字节流（无消息边界），因此是纯数据驱动的分阶段解析。

### 收 path：`tls_open_record`（`tls_record.cc:91`）

```text
读入 record 头(5B) → 校验版本 → 校验密文长度 → 抽取载荷
  → (TLS1.3 握手期) 跳过 ChangeCipherSpec 空记录，discard
  → (0-RTT 拒绝期) skip_early_data，discard
  → 序号溢出检查 → AEAD Open 解密 → read_sequence++
  → (TLS1.3) 剥 padding 并取内层真实类型
  → 空记录计数/警告计数限流 → 类型分发
      → alert → ssl_process_alert（close_notify / fatal / warning）
      → handshake / app_data → 交给握手层或应用层
```

- 输出三元：`ssl_open_record_success` / `ssl_open_record_partial`（等待更多数据）/ `ssl_open_record_discard`（消费但不交付，如 CCS、被拒 early data、warning alert）以及错误路径 `ssl_open_record_error` / `ssl_open_record_close_notify`。
- 每次解密失败发 `bad_record_mac`（`tls_record.cc:190`）；明文超限发 `record_overflow`；版本不符发 `protocol_version`。
- **不变量**：明文长度 ≤ 2^14（TLS1.3 因内层类型 +1，`tls_record.cc:204`）；空记录/警告各限 32/4 次（`tls_record.cc:34,45`）；被拒 early data 跳过上限 16K（`tls_record.cc:41`）；序号在 2^64 处溢出检测（`tls_record.cc:175`）。

### 发 path：`tls_seal_record`（`tls_record.cc:411`）

```text
别名检查 → 计算 prefix/suffix 长度 → 溢出/缓冲区检查
  → TLS1.3: 外层 type 固定为 application_data，真实类型追加为内层 1B
  → AEAD SealScatter → write_sequence++
```

- TLS1.0 CBC 1/n-1 记录拆分（`tls_seal_scatter_record`，`tls_record.cc:365`）仅在 `ssl_needs_record_splitting` 时为兼容老密码套件启用。
- 握手层写消息经 `ssl->method->add_message` / `finish_message` 队列，`tls_flush` 统一刷出（`tls_method.cc` 的 `kTLSProtocolMethod` 表，`tls_method.cc:113`）。

### record 层与握手层的交互

- 握手期的 record 解码由 `ssl_run_handshake` 的 `ssl_hs_read_message` 分支发起（`handshake.cc:577` 调用 `ssl_open_handshake`），解析出的握手消息经 `tls_get_message`/`tls_next_message`（协议方法表）递进。
- **手握手不完整记录**：`tls_open_record` 返回 `partial` 时 `ssl_handle_open_record` 让外层等待更多 TCP 数据，这是 record 层与 TCP 流语义的关键边界。
- **握手消息不得与其它 record 类型交错**：`tls_record.cc:247` 拒绝在未处理完握手数据时出现其它类型 record。
- **加密切换时机**：TLS1.2 由握手状态（ChangeCipherSpec 前后）直接调用 `tls_set_read_state` / `tls_set_write_state`（`tls_method.cc:43,75`）切换 `aead_read_ctx` / `aead_write_ctx`；TLS1.3 由 key schedule 各阶段（handshake traffic / application traffic / early data）决定。