# TLS

## 定位

TLS 位于传输层（TCP）之上、应用层（HTTP 等）之下，解决「在不安全信道之上提供机密性、完整性和对端身份认证」的问题。本模块以 BoringSSL 为主实现，重点覆盖：record 层、握手状态机、证书验证、密钥调度（key schedule）、会话恢复（resumption）与 0-RTT。

在协议主干中的位置：`TCP → TLS → HTTP/1.1 → HTTP/2`。TLS 依赖 TCP 提供有序可靠字节流（DTLS 除外，本模块只讨论 TLS over TCP），为上层 HTTP 等提供透明的安全通道。

本模块只负责建立并维护安全会话；不负责应用层消息语义、TCP 拥塞控制等（由相邻模块承担）。

## 前置模块

- **TCP**：TLS record 承载于有序可靠的字节流之上；握手与报文边界依赖 TCP 的流语义。
- **协议抽象与报文编码**：多字节整数、长度字段、TLV 风格的扩展编码是解析 TLS 报文的基础。
- （可选的横向参照）**密码学基础**：对称加密、MAC/AEAD、公钥签名与密钥交换，不要求先读某个源码模块。

## 推荐阅读顺序

1. `protocol.md` — 先建立问题定义、抽象对象、wire format 与核心机制的整体框架。
2. `state-machine.md` — 再看 client/server 的握手状态机（TLS1.2 vs TLS1.3）与 record 层处理流程。
3. `src/README.md` — 按文件清单进入源码，先读 `core/`（record、handshake、key share），再沿一条调用链补 `integration/`。
4. 关键源码文件建议顺序：`tls_method.cc`（方法/协议版本框架）→ `tls_record.cc`（record 层）→ `handshake_client.cc` / `handshake_server.cc`（握手状态机）→ `handshake.cc`（状态机驱动与公共机制）→ `ssl_key_share.cc`（密钥交换）。
5. `references.md` — 对照 RFC 8446/5246 与 OpenSSL、rustls 的实现取舍。

## 源码入口

见 `src/README.md`。核心入口：

- 公共握手入口（未复制，见依赖说明）：`SSL_connect` / `SSL_accept` / `SSL_do_handshake`。
- 握手状态机驱动：`ssl_run_handshake`（`src/upstream/ssl/handshake.cc`）。
- 客户端状态机：`ssl_client_handshake`（`src/upstream/ssl/handshake_client.cc`）。
- 服务端状态机：`ssl_server_handshake`（`src/upstream/ssl/handshake_server.cc`）。
- record 收发：`tls_open_record` / `tls_seal_record`（`src/upstream/ssl/tls_record.cc`）。

## 主实现 / 对照实现

- 主实现：**BoringSSL**（`github.com/google/boringssl`），固定 commit 见 `references.md`。
- 对照实现：OpenSSL（BoringSSL 的母体）、rustls（Rust 内存安全实现），用于比较握手状态机与内存/错误处理取舍。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。源码保留上游相对路径于 `src/upstream/`，许可证位于 `src/LICENSES/`。
