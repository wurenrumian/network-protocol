# 协议抽象与报文编码 · src

本模块是方法论文档，**无单一主实现、无复制源码**（`src/upstream/` 保持为空）。本文件是源码导航页，只维护"参考来源清单"：用于归纳分析语言的外部上游文件，按"文件 → 类别 → 阅读范围"列出，并标注未复制的依赖。阅读时沿清单到对应上游仓库查看，不在本仓库内复制。

## 类别说明（对应 `protocol-learning-design.md` §3）

- `core/`：协议本身——报文、状态机、定时器、队列；
- `integration/`：与其他协议、socket、TLS、事件循环的连接；
- `platform/`：网卡、系统调用、线程/锁、操作系统适配。

本模块所有参考来源都标注类别；复制文件时保留上游路径。

## 文件清单（文件 → 类别 → 阅读范围）

### lwIP（主参考：字节序、校验、TCP 状态机）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/include/ipv4/ip4.h` | core | 字节序宏、`htons/htonl/ntohs/ntohl`、`ip4_checksum` 声明 |
| `src/core/ipv4/ip4.c` | core | `ip4_checksum` 实现（16 位补码和）、`ip4_input` / `ip4_output` 的校验与长度处理 |
| `src/core/tcp_in.c` | core | TCP 收包：校验（伪首部）、序列号合法性（区间判断）、状态转移（SYN/ACK/FIN）、RST 处理 |
| `src/core/tcp_out.c` | core | 分段、重传、发送窗口推进 |
| `src/core/tcp_tmr.c` | core | 定时器：重传、keepalive、TIME-WAIT 清理 |

阅读范围提示：`tcp_in.c` / `tcp_out.c` 各含大量无关功能（如紧急数据、MSS 选项），只读与"校验、状态转移、重传"相关的函数（在文件内用注释标出本次阅读范围，不拆改源文件）。

### BoringSSL（主参考：record 长度边界、完整性、版本协商）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `ssl/record/record.c` | core | record 层：16 位长度字段、完整 record 读入、长度验证 |
| `ssl/record/tls13encrypt.c` | core | AEAD 加密 / 解密与完整性标签（GCM tag） |
| `ssl/statem/`（`statem.c` 等） | core | handshake 状态机：ClientHello/ServerHello/Finished、`supported_versions` 协商、非法状态处理 |

阅读范围提示：`ssl/statem/` 较庞大，先读状态机数据结构与 `dtls1_` / `tls13_` 相关的状态转移函数。

### protobuf（主参考：varint、TTLV/嵌套）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `java/core/src/main/java/com/google/protobuf/` 的 `WireFormat`（`TaggedField` / `Varint`）或 `cpp/src/google/protobuf/` 的 `wire_format.cc` | core | varint 编解码（`readVarint32`/`writeVarint32`）、tag（field number + wire type）、length-delimited 消息嵌套 |

阅读范围提示：重点看 varint 的"每字节 7 位 + 高位续延"以及嵌套 message 的递归 TLV 结构，其余（map/repeated）可跳过。

### quiche（主参考：VarInt 长度前缀、packet 布局、版本协商）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/lib/` 的 `read_varint` / `write_varint` | core | QUIC VarInt：前两位指示后续字节数的长度前缀整数 |
| `src/lib/packet/`（如 `packet.rs`） | core | QUIC packet 编码：header form、packet number 空间、length 字段 |
| `src/lib/` 的 version negotiation 处理 | core | Version Negotiation 报文与版本协商失败路径 |

### nginx（主参考：delimiter 分帧、逐步解析）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/http/ngx_http_parse.c` | core | HTTP/1.1 解析：`\r\n` 定界、请求行/头部/Content-Length、chunked 分块 |

阅读范围提示：只读解析主循环与状态分支（`s_...` 状态），跳过与事件循环 / 缓存相关的集成部分。

### nghttp2（主参考：帧类型表、流状态机）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `lib/nghttp2_frame.c` | core | HTTP/2 帧头（9 字节：length/type/flags/stream-id）、帧类型分发 |
| `lib/nghttp2_session.c` | core | 流状态机（IDLE→OPEN→...→CLOSED）、HPACK 编码 |

### Wireshark（对照：从字节流反推字段结构）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `epan/dissectors/packet-ip.c` | integration | IPv4 dissector：逐字段解析顺序、字节序处理 |
| `epan/dissectors/packet-tcp.c` | integration | TCP dissector：端口/序号/标志解析 |
| `epan/dissectors/packet-tls.c` | integration | TLS record dissector：record 长度与内容类型 |

用途：作为"从字节流反推字段结构"的对照，验证本模块对字段解析顺序与字节序的处理假设。

## 阅读顺序与调用链

本模块无实际复制源码，沿下列"概念 → 参考文件"的顺序阅读（与 `protocol.md` §3 的顺序一致）：

```text
报文布局      → ip4.h / packet-ip.c（固定头 + 可变区）
字节序        → ip4.h（htons/ntohl 宏）→ packet-ip.c（解析时转换）
长度与边界    → tcp_in.c（长度验证）→ record.c（TLS 16 位长度）
TLV           → protobuf wire_format（varint + tag）→ tls13encrypt / statem（extension）
校验          → ip4.c（ip4_checksum）→ tcp_in.c（伪首部校验）→ record.c（AEAD）
版本/扩展     → statem（supported_versions）→ quiche（version negotiation）
状态机        → tcp_tmr.c / statem.c（显式状态）→ nghttp2_session.c（流状态）
超时/错误模型 → tcp_tmr.c（定时器）→ quiche（丢包恢复）
```

建议按此顺序逐条完成：先读规范（references.md），再读对应实现文件验证概念，最后回到 protocol.md 对照不变量。每条路径可独立阅读，无需一次性读完。

## 入口函数 / 结束函数

| 概念 | 入口函数（参考文件） | 结束函数（参考文件） |
| --- | --- | --- |
| 字节序 | `htons` / `htonl`（ip4.h） | `ntohs` / `ntohl`（ip4.h） |
| 校验和 | `ip4_checksum`（ip4.c） | 校验结果验证处（tcp_in.c 收包入口） |
| TLS record | `tls13_encrypt_record` / `tls13_decrypt_record`（tls13encrypt.c） | record 交付 / 校验失败终止 |
| QUIC VarInt | `read_varint`（quiche src/lib/） | `write_varint`（quiche src/lib/） |
| HTTP/1.1 分帧 | `ngx_http_parse` 主循环（ngx_http_parse.c） | 解析完成 / 状态 `sw_error` 终止 |
| 状态机（TCP） | `tcp_input`（tcp_in.c 收包入口） | 状态转移到 `CLOSED` / 连接回收 |

## 未复制的依赖

本模块未复制任何上游源码，因此无"复制但未跟随"的依赖。下列为**阅读参考来源时无需复制、仅在 README 中记录**的依赖：

- **lwIP** 的 `src/include/` 其余头文件（`opt.h`、`err.h` 等）与本模块无关，不复制；
- **BoringSSL** 的 `crypto/` 下层密码库（AES-GCM 等）仅用于理解 AEAD 强度，不复制；
- **quiche** 依赖的 TLS 层（BoringSSL 绑定）仅说明完整性由 TLS 提供，不复制；
- **nginx / nghttp2** 的事件循环、内存池、缓冲区（`ngx_event/`、`ngx_pool` 等）与"分帧"概念无关，不复制；
- **Wireshark** 的 `epan/` 框架（包树、过滤引擎）不复制，只读 dissector 文件。

若后续需要为本模块补充少量示例（如一个可运行的 wire 编解码小样例），应先确认其协议动机与 references.md 中的来源一致，并置于 `src/upstream/` 之外的示例目录，不混入上游结构。