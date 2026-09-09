# 自定义协议设计 · src

本模块以方法论为主，没有单一主实现源码。`src/` 只复制少量「设计参考」示例，用来把 protocol.md 中的 wire format 论点落到真实解析器上，不做闭环要求的完整源码（无单一实现可追踪）。文件未经修改，仅可在此副本上加学习注释。

## 上游版本

| 上游 | 版本 / commit | 复制路径 |
| --- | --- | --- |
| Redis | `7.2.4`（tag） | `src/upstream/redis/src/resp_parser.c`、`resp_parser.h` |

原始相对路径：`src/resp_parser.c`、`src/resp_parser.h`（相对 Redis 仓库根），副本保留 `redis/src/` 目录结构。

## 文件清单（文件 → 类别 → 阅读范围）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `redis/src/resp_parser.c` | core/（RESP 回复解析器） | 全部 228 行：`parseReply` 分发、各 `parse*` 解析函数 |
| `redis/src/resp_parser.h` | core/（解析器接口） | 全部 94 行：`ReplyParser` 结构、`ReplyParserCallbacks` 回调表 |

## 阅读顺序与调用链

```text
resp_parser.h: ReplyParser 结构 / 回调表  →  定义「解析结果如何交付」
  →  resp_parser.c: parseReply()            →  按类型标签分发
  →  resp_parser.c: parseBulk/parseSimpleString/parseArray/...  →  各类型的长度前缀解析
```

入口：`resp_parser.c:210` `parseReply(ReplyParser *parser, void *p_ctx)`。
结束：各 `parse*` 函数完成「推进 `curr_location` + 调用对应回调」即返回，无出口聚合函数。

## 入口函数 / 结束函数

- **入口**：`parseReply`（`resp_parser.c:210`）——按 `curr_location[0]` 首字符分发到具体 `parse*`。
- **核心状态**：`parser->curr_location`（`resp_parser.h:88`）——指向尚未解析的字节，每次调用推进到下一个完整值；这是「游标式解析器」的无显式状态机核心（见 `state-machine.md` 的「处理流程」节）。
- **各 parse\* 的原子操作**（以 `parseBulk` `resp_parser.c:61` 为例）：找 `\r` → 取十进制长度 → 跳过 `\r\n` → 前进 bulklen → 再前进 `\r\n`；若长度为 `-1` 视为 null bulk，走 `null_bulk_string_callback`。

## 未复制的依赖

`resp_parser.c` 编译依赖以下符号，均属 Redis 内部基础设施，与协议设计论点无关，故未复制：

- `resp_parser.h`（已复制）、`server.h`（提供 `string2ll`、`MAX_LONG_DOUBLE_CHARS`、`C_OK`/`C_ERR`）；
- 回调使用方的调用路径（Redis 模块回复、`call_reply.c`）——不在本模块阅读范围；
- 连接侧增量解析/半帧处理位于 `src/networking.c`，未复制（见 `references.md` 阅读备注，`state-machine.md` 的「无显式状态机」节有说明）。

## 许可证

副本对应的许可证为 Redis 的 BSD-3-Clause，已复制到 `src/LICENSES/COPYING.redis-7.2.4`（取自 Redis 仓库根 `COPYING`，与 `resp_parser.c/h` 头部版权声明一致）。