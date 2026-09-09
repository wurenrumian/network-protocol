# 自定义协议设计 · references

本模块以方法论为主，无单一主实现。本页固定三个对照片段的规范与源码位置。

## 规范 / 标准

- **RESP protocol spec** — Redis 官方 RESP3 规范：`https://redis.io/docs/reference/protocol-spec/`（含 RESP2/RESP3 的完整类型列表与 `HELLO` 协商语义）。
- **MySQL Internals: Client/Server Protocol** — MySQL 官方协议文档：`https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html`（握手包、能力位、packet 格式、命令号）。
- **Kafka protocol guide** — Confluent 维护的协议指南：`https://kafka.apache.org/protocol`（request/response 结构、api_version 协商、compact 编码、error_code 表）。
- **RFC 1925**（声明通用性：不复制到本模块，供链路层校验对比用）。

## 论文

- 无直接论文；「版本兼容与灰度升级」一节参考了 **Semantic Versioning（semver.org）** 的兼容性分类思想，以及 **Postel's Law**（宽松接收、严格发送）的经典表述。

## 上游仓库（固定版本 / commit）

| 协议 | 仓库 | 固定版本 | 本模块用途 |
| --- | --- | --- | --- |
| Redis (RESP) | `github.com/redis/redis` | `7.2.4` | 已复制 `src/resp_parser.c`、`src/resp_parser.h` 到 `src/upstream/redis/src/`（见 `src/README.md`） |
| MySQL server | `github.com/mysql/mysql-server` | `8.0`（branch `8.0`） | 未复制，仅读 `sql/` 与 `libmysql/` 中的 packet 处理理解能力位协商 |
| Kafka (Java) | `github.com/apache/kafka` | `3.x`（建议 `3.5.0`） | 未复制，读 `clients/src/main/java/org/apache/kafka/clients/` 的 `NetworkClient` 与 `ApiVersion` 相关类理解 api_version 协商 |

## 其他实现

- **RESP 其他实现**：`resp3`（Rust crate）、`redis` python client（`redis/connection.py`）——对照「同一协议在不同语言下的解析差异」。
- **Kafka 协议生成器**：`apache/kafka` 的 `generator` 模块与 JSON schema（`protocol/` 目录）——观察「schema 驱动的协议代码生成」这一设计选择。
- **MySQL 轻量实现**：`mariadb-corporation/mariadb-connector-c`（`libmariadb/`）——对照能力位协商的 C 实现。

## 阅读备注

- **三协议对照结论**（详见 `protocol.md`）：
  - RESP：文本、自描述、连接级版本协商（`HELLO`）、无应用层校验；适合「调试优先、人类可读」的协议。
  - MySQL：二进制、payload 依赖会话上下文、能力位（特性布尔集）协商、四字节序列号防错配。
  - Kafka：二进制、per-API 版本号协商、compact 变长编码、CRC 校验、请求 ID + producer 幂等。
- **示例源码阅读路线**：先读 `resp_parser.h`（回调结构 = 解析器的「协议语义接口」），再读 `resp_parser.c`（`parseReply` 分发 → 各 `parse*` 实现）。
- **已知裁剪**：`resp_parser.c` 依赖 `resp_parser.h`、`server.h`（`string2ll`、`MAX_LONG_DOUBLE_CHARS`）、`C_OK/C_ERR` 定义；本项目只复制了自包含的两个文件，`server.h` 等依赖未复制（见 `src/README.md` 的「未复制的依赖」）。
- **版本说明**：Redis 7.2.4 为该分支的 `resp_parser.*` 引入点；更早版本没有独立 `resp_parser.c`，RESP 解析内联在 `networking.c` 与 `call_reply.c` 中——若回溯早期实现，路径不同，勿在本模块下直接对照。