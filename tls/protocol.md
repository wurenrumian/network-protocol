# TLS · protocol

## 问题定义

TLS（Transport Layer Security，RFC 8446 为 TLS 1.3）在不可信、可被窃听/篡改/伪造的传输层（TCP）之上，为应用层提供一个安全通道，需要同时解决：

1. **机密性（Confidentiality）**：应用数据在传输中不被第三方读取。
2. **完整性（Integrity）**：数据在传输中不被篡改且不被重放。
3. **对端认证（Authentication）**：确认通信对端的身份（通常由服务端出示证书，客户端可选用证书/密码认证）。
4. **密钥协商**：双方在不公开会话密钥的前提下协商出一致、新鲜的会话密钥，并向前保密（forward secrecy）。

TLS **不负责**：应用的业务语义、拥塞控制与可靠传输（依赖 TCP）、身份信任的根（信任锚由外部配置的 CA 提供）、抵抗端侧攻击。

## 抽象对象

- **会话（SSL_SESSION）**：一次成功握手的产物，保存会话 ID、ticket、版本、密码套件、主密钥/恢复密钥、对端身份等，用于会话恢复。抽象类型 `SSL_SESSION`，由 `ssl_session.c` 管理（未复制）。
- **握手状态机（SSL_HANDSHAKE / hs）**：驱动握手的内部对象，维护当前状态、待发/待收消息哈希（transcript hash）、密钥调度状态等。抽象类型 `SSL_HANDSHAKE`，定义于 `ssl/internal.h`（未复制，见依赖说明）。
- **握手消息（SSLMessage）**：握手层的一个完整消息，如 ClientHello、ServerHello、Certificate。用 `SSLMessage` 抽象，`ssl_parse_message`/`ssl_add_message_cbb` 负责解析与构造。
- **record**：record 层的加密/明文数据单元，`SSLImpl`（连接对象，`struct ssl_st` 的内部实现）与收发状态在其中体现。
- **密钥调度状态（key schedule state）**：TLS1.3 中按阶段推进的密钥派生态，包括 handshake secret、master secret、各自的 traffic secret 与 finished key，抽象为连接上的若干 `SSL_TRANSCRIPT`/secret 字段，写入 `ssl_crypto_x509_session`/`SSL_AEAD_CTX`。

## wire format

### TLS record header（record 层）

每个 record 由 5 字节头 + 载荷组成：

```
+------+------+------+------+------+------------------+
| type |      version     |   length    |   payload    |
+------+------+------+------+------+------------------+
  1B       2B       2B              <= 2^14 + 2048 明文上限
```

- **type**：content type，`handshake(22)`、`change_cipher_spec(20)`、`alert(21)`、`application_data(23)`。
- **version**：对于 TLS1.3 之后的 record，为兼容标记 `0x0303`（TLS1.2），真实版本由握手协商。
- **length**：payload 字节数，明文 record 上限 2^14+2048；应用数据必须分片到 <=2^14。

TLS1.3 中，加密后的 record 还带 **inner content type**（写入加密载荷尾部 1 字节，取值为真实类型），因为外层 record type 固定为 `application_data`，用 `ssl_record_app_data`/`tls_seal_record` 处理。见 `src/upstream/ssl/tls_record.cc`。

### 握手消息（handshake message）

握手层消息包在 record 里，自身有 4 字节类型 + 3 字节长度：

```
+-------+-----------+---------+-----------------+
| type  |  length   |  body   |
+-------+-----------+---------+-----------------+
  1B        3B
```

body 是一系列握手特定结构。TLS1.3 中每个握手消息在 `msg_type` 之外还有 `msg_len` 前缀（`SSLMessage` 的解析见 `handshake.cc` 的 `ssl_parse_message`）。

### ClientHello / ServerHello

**ClientHello**（TLS1.3 简略）：

```
legacy_version(2B)  | random(32B) | legacy_session_id(变长) |
cipher_suites(2B len + list) | legacy_compression_methods |
extensions(2B len + list)
```

关键扩展：`supported_versions`（承载真实的 TLS1.3 版本，因 legacy_version 固定为 0x0303）、`supported_groups`、`key_share`（客户端提供的密钥交换份额）、`signature_algorithms`、`psk_key_exchange_modes`、`pre_shared_key`（会话恢复）、`early_data`（0-RTT 标记）。

**ServerHello**（TLS1.3）结构类似，选择单一 cipher suite、group、key_share 份额；若协商 0-RTT 则含 `early_data` 扩展。TLS1.2 中版本与密码套件直接由握手版本/hello 决定。

### 密钥交换（key exchange）

TLS1.3 中 `key_share` 携带群元素：X25519（32B 公钥）、P-256（64B）等，另支持 ML-KEM（X25519MLKEM768、MLKEM1024）。服务端从客户端提供的份额里选一个，返回自己的份额。抽象为 `SSLKeyShare` 类，`SSLKeyShare::Create` 按 group id 实例化，见 `src/upstream/ssl/ssl_key_share.cc`。

### TLS1.3 的 key schedule

基于 HKDF-Extract / HKDF-Expand，链式派生态：

```
       0
       |
       v
PSK ->  HKDF-Extract = Early Secret
       |                     +-----> Derive-Secret(., "ext binder" | "res binder", "")
       |                     +-----> Derive-Secret(., "c e traffic", ClientHello)
       v
     Derive-Secret(., "derived", "") = Derive-Secret
       |
       v
   (EC)DHE -> HKDF-Extract = Handshake Secret
       |                     +-----> Derive-Secret(., "c hs traffic", ClientHello...ServerHello)
       |                     +-----> Derive-Secret(., "s hs traffic", ClientHello...ServerHello)
       v
     Derive-Secret(., "derived", "") = Derived
       |
       v
  0 -> HKDF-Extract = Master Secret
       +-----> Derive-Secret(., "c ap traffic", ClientHello...server Finished)
       +-----> Derive-Secret(., "s ap traffic", ClientHello...server Finished)
       +-----> Derive-Secret(., "res master", ClientHello...client Finished)
```

「traffic secret」经 `HKDF-Expand-Label` 生成 `key`/`iv`（AEAD 参数）。BoringSSL 中该逻辑位于 `tls13_enc.cc`（未复制，见 `src/README.md` 依赖说明），`SSL_TRANSCRIPT` 维护 transcript hash。

## 核心机制

### record 层

职责：明文数据分片（<=2^14）、加密封装、对端 record 的接收/解密/重组、跨 record 的流式解析（TCP 无消息边界）。主要函数在 `src/upstream/ssl/tls_record.cc`：`tls_open_record`（接收并解密一条 record，返回 `ssl_open_record_success/partial/discard/error/close_notify` 等）、`tls_seal_record`（加密并写出）。record 层是独立于握手的小状态机：等待头 → 等待载荷 → 解密校验。

### 握手流程

1. **协商**：ClientHello/ServerHello 协商版本、密码套件、群、密钥交换参数。
2. **认证与密钥交换**：TLS1.2 用 Certificate/ServerKeyExchange/ClientKeyExchange + ChangeCipherSpec + Finished；TLS1.3 用 EncryptedExtensions、Certificate/CertificateVerify、Finished（多数在握手流量密钥建立后加密发送）。
3. **完成**：双方各自验证 Finished 的 transcript，交换应用流量密钥。
4. **会话恢复**：客户端可在后续握手携带 session ticket / PSK 直接恢复，跳过证书与密钥交换。

服务端在 `handshake_server.cc` 中先判定是否走 TLS1.3（`ssl_server_handshake` 分支到 `tls13_server_handshake`），客户端类似（`ssl_client_handshake` → `tls13_client_handshake`）。公共驱动在 `handshake.cc` 的 `ssl_run_handshake`，它循环解析 `hs->wait` 条件（读消息、刷写出、私钥操作等）推进状态机。

### 证书验证

`ssl_verify_peer_cert`（`src/upstream/ssl/handshake.cc`）负责校验对端证书链：检查有效期、签名、密钥用途、域名匹配（通过 X.509 校验回调/内置路径，依赖 `x509` 模块，未复制）。验证结果 `ssl_verify_ok` / `ssl_verify_invalid` / `ssl_verify_retry`。

### 密钥调度

见上文「TLS1.3 的 key schedule」。TLS1.2 使用 PRF（基于 HMAC）从 premaster secret 派主密钥，再派生各方向密钥；TLS1.3 统一为 HKDF 链式调度，并让 Finished 密钥绑定整个 transcript，杜绝降级攻击。

### 会话恢复

两种机制：

- **session ticket（TLS1.2 兼容）**：服务端把会话状态加密成 ticket 发给客户端，客户端下次握手回传。
- **PSK / pre_shared_key（TLS1.3）**：握手时通过 `pre_shared_key` + `psk_key_exchange_modes` 扩展直接恢复，配合 `early_data` 扩展支持 0-RTT。

恢复可显著减少握手 RTT（TLS1.3 全握手 1-RTT，PSK 恢复 0-RTT 或 1-RTT）。

### 0-RTT（early data）

客户端在 **ClientHello 之后立即**发送加密的应用数据（`early_data` 扩展 + `EndOfEarlyData`），前提是之前已与同一服务端建立过会话并持有 PSK。要点：

- 0-RTT 数据只有机密性/完整性，**不防重放**（对端可在时间窗内重放），需服务端实现 anti-replay 机制（如 ticket 一次性使用、预共享密钥 + 随机 nonce）。
- 只有 idempotent（幂等）的请求才适合 0-RTT。
- record 层对 early data 使用 `early traffic secret` 加密，且外层 record type 为 `application_data`（见 `tls_record.cc` 的 `skip_early_data` / early data 打开路径）。

## 设计取舍

- **TLS1.3 精简握手**：去掉 TLS1.2 的 ServerKeyExchange、ChangeCipherSpec、压缩、静态 RSA 密钥交换，降低握手 RTT（1-RTT/0-RTT），并强制前向保密（禁止 RSA 密钥传输）。
- **统一密钥调度**：用 HKDF 链式调度替代 TLS1.2 的 PRF，每阶段 secret 绑定 transcript，天然抗降级与消息重排。
- **0-RTT 以重放风险换延迟**：用幂等性约束 + anti-replay 换取首包即发数据。
- **record 层与握手解耦**：record 只负责分片/加密，握手指定流量密钥时机，便于支持 TLS1.2/1.3 共用框架。
- BoringSSL 相比 OpenSSL：去掉大量历史兼容与代码路径，减少攻击面；提供内部分层 `SSLImpl`（内部实现类）以支持 QUIC（`SSL_is_quic` 分支在 `ssl_run_handshake` 等处可见）。

## 不变量

- **record 明文 <= 2^14**：应用数据分片到该上限，避免超长缓冲。
- **握手消息不可跨 record 无界累积**：`SSLMessage` 解析强制长度检查，超限报 `message_length` 警报。
- **密码套件/密钥交换需协商一致**：client/server 必须在同一版本、群、套件上收敛，否则握手失败。
- **Finished 必须匹配 transcript**：若 transcript 哈希不一致则终止握手（防篡改/降级）。
- **0-RTT 只由已知 PSK 触发**：未知 ticket 不得接受 early data，且服务端必须校验并限制重放。
- **密钥材料只用一次且方向隔离**：client/server 流量密钥分离，互不混用。

## 边界条件与异常处理

- **record 类型未知/版本不符**：`tls_open_record` 返回错误并触发 `unexpected_message`/`protocol_version` 警报。
- **消息顺序错误**：握手状态机对每类消息做顺序校验（`ssl_check_message_type`），非法类型触发 `unexpected_message` 警报。
- **长度/编码错误**：长度字段非法、扩展重复或未知 → 解析失败，返回 `ssl_open_record_error` 并发送警报。
- **解密/完整性校验失败**：`tls_open_record` 返回错误，触发 `bad_record_mac` 警报并（通常）终止连接。
- **证书验证失败**：`ssl_verify_peer_cert` 返回 invalid，客户端可选择忽略（不安全配置）或终止。
- **私钥操作慢/异步**：握手可停在 `ssl_hs_private_key_operation`，`ssl_run_handshake` 通过 `hs->wait` 让出并等待事件循环（integration 点）。
- **部分 record（TCP 分片）**：`ssl_open_record_partial`，等待更多数据；这是 record 层与 TCP 流交互的关键边界。
- **0-RTT 重放**：服务端须通过一次性 ticket / anti-replay 窗口拒绝重放，属安全边界而非功能失败。
- **会话恢复失败**：若恢复密钥不匹配，回退到完整握手。
