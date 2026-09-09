# 协议抽象与报文编码 · references

本模块是方法论文档，不绑定单一主实现；以下来源用于归纳分析语言，覆盖本模块八个概念面（布局、字节序、长度/边界、TLV、校验、版本/扩展、状态机、超时/错误模型）。

## 规范 / 标准

- **RFC 791 — Internet Protocol**：IPv4 头布局、version/IHL、Total Length、头校验和、分片。观察重点：字节序（网络序）、长度字段与分片、头校验覆盖范围。
- **RFC 793 — Transmission Control Protocol**：段格式、序号与确认、11 状态状态机、RTO 与重传。观察重点：隐式状态（窗口/序号）与显式状态、定时器语义、错误处置的对称性。
- **RFC 768 — User Datagram Protocol**：8 字节头、长度字段、校验和（含伪首部）。观察重点：长度字段最小/最大、伪首部跨层校验覆盖。
- **RFC 8200 — IPv6**：固定 40 字节头、Next Header 链（扩展头链）、无头校验、分片改为扩展头。观察重点：版本演进如何改变固定头语义、校验策略变化。
- **RFC 8446 — TLS 1.3**：record 层、handshake 状态机、`supported_versions` 版本协商、AEAD 完整性。观察重点：版本协商、扩展机制、record 长度与完整性边界。
- **RFC 9000 — QUIC: A UDP-Based Multiplexed and Secure Transport**：packet 编码、VarInt、packet number、丢包恢复、连接迁移。观察重点：变长整数、packet 布局、无连接状态在 QUIC 中的隐式化。
- **RFC 8792 — Robust and Concurrent Checksums**（若有需要时）：校验和演进讨论。默认以 RFC 1071（Internet Checksum）为主要校验参考。

## 论文

- **V. Jacobson — Congestion Avoidance and Control**（1988）：TCP 定时器 / RTO 估计的奠基。观察重点：RTO 的 RTT 自适应、定时器语义。
- **Paxson — End-to-End Internet Packet Dynamics**（1999）：对端行为多样性、乱序 / 重排统计。观察重点：错误模型（乱序 / 重复 / 延迟）的真实分布，用于理解"定时器值"与"重排容忍"。
- **Edmondson & Yaksha（可选）**：TLS 状态机错误（三态 / 3Shake 攻击）分析，暴露"未定义状态组合"是安全漏洞根源。观察重点：状态机完整性（每个 (S,E) 都需定义）的安全性含义。

## 上游仓库（固定版本 / commit）

本模块不复制源码（`src/upstream/` 为空），以下仓库为参考来源（与 `protocol-learning-design.md` §4.0 选型一致，但本模块只取其公共抽象，不深入内部实现）：

- **lwIP**：https://savannah.nongnu.org/projects/lwip/
  观察点：`src/include/ipv4/ip4.h`（字节序宏、`htons/htonl/ntohs/ntohl`、`ip4_checksum` 所在文件 `src/core/ipv4/ip4.c`）、`src/core/tcp_in.c`（TCP 状态机与校验）、`src/core/tcp_out.c`（分段与重传）、`src/core/tcp_tmr.c`（定时器）。
- **BoringSSL**：https://boringssl.googlesource.com/
  观察点：record 层（`ssl/record/` 的 `tls13encrypt.c` / `record.c`）、handshake 状态机（`ssl/statem/`）。重点：length 边界验证、AEAD 完整性、版本协商。
- **protobuf**：https://github.com/protocolbuffers/protobuf
  观察点：`java/core/src/main/java/com/google/protobuf/` 或 `cpp/src/google/protobuf/` 的 varint 编解码（`writeVarint32` / `readVarint32`）、tag 与 length-delimited 编码。重点：变长整数与 TLV 变体（TTLV/嵌套）。
- **quiche**：https://github.com/cloudflare/quiche
  观察点：`src/lib/` 的 VarInt 读写（`read_varint` / `write_varint`）、packet 编解码（`src/lib/packet/`）、version negotiation（`src/lib/`）。重点：QUIC VarInt 的长度指示前缀、packet 布局。
- **nginx**：https://nginx.org/
  观察点：`src/http/ngx_http_parse.c`（HTTP/1.1 分帧解析：`\r\n` 定界、Content-Length / chunked）。重点：delimiter 与 length-delimited 的混合、解析器逐步验证。
- **nghttp2**：https://github.com/nghttp2/nghttp2
  观察点：frame 解析与 stream 状态机（`lib/nghttp2_frame.c`、`lib/nghttp2_session.c`）。重点：帧类型表驱动解析、流状态机。
- **Wireshark**：https://www.wireshark.org/
  观察点：`epan/dissectors/` 中各协议 dissector（`packet-ip.c`、`packet-tcp.c`、`packet-tls.c`）。用途：作为"从字节流反推字段结构"的观察参照，展示字段解析顺序与字节序处理。

### 固定版本说明

本模块不固定某一 commit（因无源码复制）。若后续需要引用具体行，建议固定上述仓库的 LTS / 当前稳定 tag，并在本文件记录 `git describe` 或 commit hash。

## 其他实现

- **Linux 内核**（`net/ipv4/ip_input.c` 等）：对照 lwIP 的 IP 校验、TCP 状态机实现，观察"用户态 vs 内核"的差异（仅作对照，不作为本模块主源码）。
- **Python `struct`** 与 **`scapy`**：快速原型 wire 格式的编码/解析，验证字节序与长度边界假设（不复制）。
- **Wireshark 的 `rawshark` / `tshark`**：命令行观察 wire 字节，验证"编码对称性"（发送方编码 → 解析器还原）。

## 阅读备注

- 本模块是主干第一个模块，阅读后续模块（§4.2 起）时，应把具体协议映射回本模块的八个概念面；
- 不变量（protocol.md §6）与状态机框架（state-machine.md §1）是跨模块复用最多的内容，建议作为"回到主干"的锚点；
- 若在具体模块中发现某个概念在本模块描述不准确（如 IPv6 无头校验使"校验覆盖范围"需修正），应回本模块更新，保持主干一致；
- 源码选择与注释规则遵循 `protocol-learning-design.md` §3；本模块因无主实现，`src/README.md` 承担源码导航职责。