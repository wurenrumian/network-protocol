# TLS · references

## 规范 / 标准

- **RFC 8446 — The Transport Layer Security (TLS) Protocol Version 1.3**（TLS1.3 主规范：握手、record、key schedule、0-RTT、PSK 恢复、版本协商/降级保护）。
- **RFC 5246 — The Transport Layer Security (TLS) Protocol Version 1.2**（TLS1.2：握手消息、PRF 主密钥派生、ChangeCipherSpec 切换、Hmac-based key derivation）。
- **RFC 6066 — TLS Extensions: Extension Definitions**（SNI、signature_algorithms 等扩展的规范基础）。
- **RFC 7627 — Transport Layer Security (TLS) Session Hash and Extended Master Secret Extension**（TLS1.2 的 extended_master_secret：把 master secret 绑定到完整握手哈希，缓解三路握手攻击；BoringSSL 在 `handshake*.cc` 中按 `ssl_ext_master_secret` 支持）。
- **RFC 5077 — Transport Layer Security (TLS) Session Resumption without Server-Side State**（session ticket 恢复机制；TLS1.3 由 RFC 8446 §2.2 / §4.2.9 的 PSK + ticket 取代）。
- **RFC 7507 — TLS Fallback Signaling Cipher Suite Value (SCSV) for Preventing Protocol Downgrade Attacks**（`SSL_CIPHER_FALLBACK_SCSV` 检查，见 `handshake_server.cc` 的 `do_read_client_hello`）。
- **RFC 8441 — Bootstrapping TLS Session Resumption / **（可选背景）。
- **RFC 7250 — Raw Public Keys in TLS and X.509**（可选背景，BoringSSL 支持 `SSLCredentialType::kRawPublicKey`）。

## 论文

- **Krawczyk, Paterson, Wee — On the Security of the TLS Protocol: A Systematic Analysis**（TLS1.3 的安全模型基础，HKDF 链式调度的形式化证明思路）。
- **Dierks & Rescorla — TLS 1.2 / 1.3 设计文档与 IETF 邮件列表讨论**（版本协商、降级保护、0-RTT 取舍的历史来源）。
- （可选）**Dowling, Stebila, Zhandry — A Formal Analysis of the TLS 1.3 Protocol**。

## 上游仓库（固定版本 / commit）

- **BoringSSL**：`https://github.com/google/boringssl`（主实现）。
  - **commit `86101b72bbb93913a00a79ac614b138633c1f4a4`**（2026-09-07，`main` 分支 HEAD）：
    - 提交信息：`Make all non-asm-included BoringSSL headers at least include <openssl/base.h>.`
    - 涉及文件：`include/openssl/dtls1.h`（不涉及本模块已复制文件）。
  - 仓库默认分支为 `main`（注意：`master` 已不返回有效 commit）。
  - 许可证：Apache License 2.0（含 OpenSSL 派生头部的版权声明，见 `src/LICENSES/LICENSE`，BoringSSL 的 LICENSE 即为 Apache-2.0 文本）。
- 源码对应关系（`src/upstream/`）：`include/openssl/ssl.h`、`ssl/handshake.cc`、`ssl/handshake_client.cc`、`ssl/handshake_server.cc`、`ssl/ssl_key_share.cc`、`ssl/tls_method.cc`、`ssl/tls_record.cc`。

## 其他实现

- **OpenSSL**（BoringSSL 的母体）：`https://github.com/openssl/openssl`。TLS1.3 握手状态机位于 `ssl/statem/`（`statem_clnt.c` / `statem_srvr.c`，用整数 `st` 状态编号 + `STITCH` 表），record 层在 `ssl/record/`（`rec_layer_s3.c`）。与 BoringSSL 对照点：BoringSSL 用 `SSL_HANDSHAKE` 对象显式承载状态与 transcript，OpenSSL 则把状态压入 `SSL_ST_*` 整数常量并依赖 `SSL_in_before`/`SSL_do_handshake` 的每次回调重入；BoringSSL 移除 OpenSSL 的大量历史兼容路径（如 SSLv3、静态 RSA、DTLS 之外的旧算法）。
- **rustls**：`https://github.com/rustls/rustls`（Rust 实现）。握手为 `HandshakeState` 驱动的显式状态机，与 BoringSSL 的 `do_*` 函数同构；差异点：rustls 全内存安全、以 trait 抽象密钥/证书提供者，BoringSSL 用 `SSL_X509_METHOD` 与 noop 替身（`tls_method.cc` 的 `ssl_noop_x509_method`）在无 X.509 时也能编译运行。
- **nss**（可选对照）：`https://github.com/mozilla/nss`，`ssl/ssl3con.c` 使用 `ssl3_GetClientHelloData` 等纯状态表，适合与 BoringSSL 的状态枚举做交叉比对。

## 阅读备注

- **未复制的 TLS1.3 核心**：`tls13_client_handshake` / `tls13_server_handshake` 子状态机、key schedule（HKDF 链式派生态）与 transcript 维护均在 `ssl/tls13_*.cc`、`ssl/tls13_enc.cc`、`ssl/tls13_key_share.cc`（上游未复制，见 `src/README.md`）。`protocol.md` 的 key schedule 图对应 RFC 8446 §7.1；`state-machine.md` 中 TLS1.3 客户端/服务端子状态序列对应 RFC 8446 §4.1.2 / §4.1.3。
- **主线阅读路径**（与 `state-machine.md` 对应）：`tls_method.cc`（协议方法表：收/发函数、加密切换、flush）→ `tls_record.cc`（record 开/封）→ `handshake.cc`（`ssl_run_handshake` 驱动、`ssl_get_finished`、`ssl_verify_peer_cert`、`ssl_parse_extensions`）→ `handshake_client.cc` / `handshake_server.cc`（状态枚举 + `do_*` 函数）→ `ssl_key_share.cc`（密钥交换群：X25519、P-256、X25519MLKEM768、MLKEM1024）。
- **阅读量参考**：已复制 7 个文件约 5,000 行；建议优先 `core/`（record + handshake + key share），`integration/`（SSLImpl 方法表、x509 接口）次之，`platform/` 仅需留意 noop 替身，不必深入。
- **与协议主干衔接**：TLS 依赖 TCP 提供有序可靠字节流，record 层的 `partial` 语义依赖此假设（无消息边界）；上层 HTTP 消费的即是 TLS 解密后的明文 record。
- **RFC 与源码编号**：`tls_record.cc` 的 `SSL3_RT_*` 常量、`SSL3_MT_*` 消息类型、`SSL_AD_*` 警报号均直接对应 RFC 8446 §5（record）与 §6（alerts）；`handshake.cc` 的 `ssl_check_message_type` 对应 RFC 8446 §4.1.1 的消息顺序约束。