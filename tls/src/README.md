# TLS · src

本页是 `src/upstream/` 下源码的导航页：只维护上游版本、文件清单、阅读顺序与调用链、裁剪/依赖说明；协议内容与状态机详见 `../protocol.md`、`../state-machine.md`。

## 上游版本

- 仓库：**BoringSSL**（`https://github.com/google/boringssl`），默认分支 `main`。
- commit：**`86101b72bbb93913a00a79ac614b138633c1f4a4`**（2026-09-07，`main` 分支 HEAD，提交信息 `Make all non-asm-included BoringSSL headers at least include <openssl/base.h>.`）。
- 许可证：Apache License 2.0，见 `src/LICENSES/LICENSE`（BoringSSL 仓库根 `LICENSE` 即 Apache-2.0 文本，含 OpenSSL 派生源文件的版权声明，本目录与其实际内容一致）。
- 源码保留上游相对路径：`src/upstream/include/openssl/ssl.h`、`src/upstream/ssl/*.cc`。

## 文件清单（文件 → 类别 → 阅读范围）

| 文件（`src/upstream/` 下） | 类别 | 职责 | 阅读范围 |
| --- | --- | --- | --- |
| `ssl/tls_record.cc` | **core** | record 层：`tls_open_record`（收/解密/分派）、`tls_seal_record`（封/加密）、alert 处理、0-RTT 跳过、TLS1.0 记录拆分 | 全文（524 行） |
| `ssl/handshake.cc` | **core** | 握手公共机制：`SSL_HANDSHAKE` 构造、`ssl_run_handshake`（状态机驱动）、`ssl_get_finished`、`ssl_verify_peer_cert`、`ssl_parse_extensions`、`ssl_check_message_type` | 全文（710 行） |
| `ssl/handshake_client.cc` | **core** | 客户端状态机：状态枚举、`do_*` 函数、`ssl_client_handshake`、ClientHello 构造 | 全文（1956 行） |
| `ssl/handshake_server.cc` | **core** | 服务端状态机：状态枚举、`do_*` 函数、`ssl_server_handshake`、参数选择、session ticket 签发 | 全文（1862 行） |
| `ssl/ssl_key_share.cc` | **core** | 密钥交换群抽象：`SSLKeyShare::Create`、X25519/P-256/P-384/P-521/X25519MLKEM768/MLKEM1024 | 全文（445 行） |
| `ssl/tls_method.cc` | **integration** | `SSL_PROTOCOL_METHOD` 表（`kTLSProtocolMethod`）绑定 record/握手层函数；`tls_set_read_state` / `tls_set_write_state`（加密切换）、`ssl_noop_x509_method`（无 X.509 时的替身） | 全文（266 行） |
| `include/openssl/ssl.h` | **integration** | 公共 API 与类型：`SSL`、`SSL_METHOD`、`SSL_SESSION`、常量与错误码 | 仅读与上述文件交叉引用的定义（如 `SSL3_RT_*`、`SSL_AD_*`、`SSL_GROUP_*`）；不逐行 |
| `ssl/handshake_client.cc` / `handshake_server.cc` 中的 TLS1.3 分支 | **core（引用）** | `state_tls13` / `state12_tls13` 转调 `tls13_*_handshake`；子状态机未复制 | 见下方「未复制的依赖」 |

## 阅读顺序与调用链

推荐一条完整调用链，沿输入到输出：

```text
SSL_connect / SSL_accept / SSL_do_handshake（未复制，公共入口）
→ ssl_run_handshake（handshake.cc:526，外层驱动循环：解析 wait → 调 do_handshake）
→ ssl_client_handshake / ssl_server_handshake（handshake_client.cc:1816 / handshake_server.cc:1722，状态机分发）
→ do_* 函数（状态转移与消息解析/构造）
→ 收：tls_open_record（tls_record.cc:91）→ ssl_open_handshake（tls_method.cc 方法表）
→ 发：tls_seal_record（tls_record.cc:411）→ tls_flush（方法表）
→ 加密切换：tls_set_read_state / tls_set_write_state（tls_method.cc:43,75）
→ 密钥交换：SSLKeyShare::Create（ssl_key_share.cc:374）
```

**建议阅读顺序**（`core` 先，再补 `integration`）：

1. `tls_method.cc` — 协议方法表把 record/握手层函数黏在一起，先建立「方法=函数表」的框架。
2. `tls_record.cc` — record 开/封，独立于握手的状态流转。
3. `handshake.cc` — `ssl_run_handshake` 驱动、Finished 校验、证书验证、扩展解析。
4. `handshake_client.cc` / `handshake_server.cc` — 客户端/服务端状态机与 `do_*` 转移。
5. `ssl_key_share.cc` — 群的具体密钥交换实现。
6. `include/openssl/ssl.h` — 阅读过程中按需查公共类型与常量，不先读。

## 入口函数 / 结束函数

| 文件 | 入口 | 结束 / 关键返回 |
| --- | --- | --- |
| `handshake.cc` | `ssl_run_handshake(SSL_HANDSHAKE *hs, bool *out_early_return)` | `ssl_hs_ok` → 握手完成（`*out_early_return` 标记 early return）；`ssl_hs_error` → -1；等待条件 → 交回调用方 |
| `handshake_client.cc` | `ssl_client_handshake(hs)` | `state_done` 退出；`ssl_client_handshake_state` 返回状态名 |
| `handshake_server.cc` | `ssl_server_handshake(hs)` | `state12_done` 退出；`ssl_server_handshake_state` 返回状态名 |
| `tls_record.cc` | `tls_open_record` / `tls_seal_record` | `ssl_open_record_{success,partial,discard,close_notify,error}`；`ssl_process_alert` 收 alert |
| `ssl_key_share.cc` | `SSLKeyShare::Create(group_id)`、`DefaultSupportedGroupIds()` | 实例化具体群；`Create` 未知 group 返回 `nullptr` |
| `tls_method.cc` | `TLS_method()`（+`TLSv1_2_method()` 等变体） | 返回 `SSL_METHOD`（含 `kTLSProtocolMethod` 与 noop X.509 方法） |

## 未复制的依赖

以下为上游 BoringSSL 中本模块闭环之外的依赖，未复制进 `src/upstream/`，阅读时按需引用：

- **`ssl/internal.h`、`ssl/ssl_*.cc`（`ssl.cc`、`ssl_privkey.cc`、`ssl_session.cc` 等）**：定义 `SSLImpl`、`SSL_HANDSHAKE`、`SSL_SESSION`、`SSLAEADContext`、密钥调度结构；公共入口 `SSL_connect` / `SSL_accept` / `SSL_do_handshake` 与 `do_handshake` 回调实现。`state-machine.md`/`protocol.md` 引用的枚举与字段（`enum ssl_hs_wait_t`、`enum ssl_client_hs_state_t` 的其余部分、`hs->wait`、`s3->read_sequence`）定义于此，未复制。
- **`ssl/tls13_client.cc`、`ssl/tls13_server.cc`、`ssl/tls13_enc.cc`、`ssl/tls13_key_share.cc`、`ssl/tls13_psk.cc`**：TLS1.3 客户端/服务端子状态机、HKDF key schedule（含 `Derive-Secret`、traffic secret 派生、early data 密钥）、transcript 维护、PSK/0-RTT 逻辑。`protocol.md` 的 key schedule 图对应 `tls13_enc.cc`；`state-machine.md` 的 TLS1.3 状态序列对应 `tls13_*.cc`。
- **`ssl/ssl_key_exchange.cc`、`ssl/ssl_cipher.cc`**：TLS1.2 的密钥交换参数编解码（`ServerKeyExchange`/`ClientKeyExchange`）与密码套件属性（`SSL_CIPHER_*`、`ssl_cipher_get_record_split_len` 等）。
- **`ssl/ssl_x509.cc` 与 `crypto/x509/`、`crypto/pem/`、`crypto/x509v3/`**：证书链解析、X.509 验证、域名匹配；`handshake.cc` 的 `ssl_verify_peer_cert` 依赖 `x509_method`（`tls_method.cc` 提供 `ssl_noop_x509_method` 作为无 X.509 构建的替身）。
- **`crypto/aead/`、`crypto/hkdf.cc`、`crypto/ec/`、`crypto/curve25519/`、`crypto/mlkem/`**：AEAD（AES-GCM / ChaCha20-Poly1305）、HKDF、ECC 与后量子 ML-KEM 的密码学原语。
- **`openssl/bytestring.h`（`crypto/bytestring/`）、`openssl/err.h`、`openssl/mem.h` 等基础头**：`CBS`/`CBB` 字节串解析构造、错误队列、内存工具。`CBS`/`CBB` 用于所有 wire format 解析/构造，是本模块语法层核心，但作为通用库未复制。
- **`crypto/poly1305/`、`crypto/chacha/`、`crypto/fipsmodule/`**（按构建配置）：底层密码实现。

### 已复制 / 跳过说明

- **已复制**：`include/openssl/ssl.h` + `ssl/` 下 6 个 `.cc`，与上游路径一一对应；`LICENSES/LICENSE` 为仓库根 `LICENSE`（Apache-2.0），未改名、未截断。
- **跳过**：构建系统（`BUILD.gn`、`CMakeLists.txt`、`generate_*`）、测试、`ssl/` 中其余 `*.cc`（见上）、`crypto/` 全部、其它 `include/openssl/*.h`。跳过理由：与本模块闭环无关或属通用库，按根目录 `protocol-learning-design.md` §3 规则仅记录依赖。
- **未改动**：复制文件未改控制流与命名；学习注释（若有）使用统一格式 `/* [RFC: ...] [STATE] [INVARIANT] [BOUNDARY] */`，不伪装成上游修改。
- **裁剪注意**：`handshake_client.cc` / `handshake_server.cc` 含 DTLS、QUIC、ECH（`ssl_ech_*`）、ChannelID、JDK11 兼容等分支，阅读时与 TLS-over-TCP 主线无关的代码按「阅读范围」列跳过，但文件保持完整。