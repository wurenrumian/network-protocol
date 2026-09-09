# 自定义协议设计 · state-machine

本文件给出自定义协议状态机的设计模式，并用一个自举的示例协议（下文 `DemoP`）演示：从状态与事件定义，到逐状态的转移，再到一个「字节流 → 完整消息」的帧状态机。约定：状态名大写，事件用 `ev:` 前缀，示例代码只示意结构，不粘大段源码。

## 状态

自定义协议的状态分两层：

1. **连接状态（会话级）**：连接从建立到关闭的宏观阶段。典型集合：
   - `CLOSED`：无连接（初始 / 关闭后）。
   - `ESTABLISHING`：已建 TCP 连接，正在握手/协商（版本、能力位、认证）。
   - `ESTABLISHED`：可正常收发业务消息。
   - `HALF-CLOSED`：一端已结束（只发/只收），另一端的语义由协议定义是否允许。
   - `CLOSING`：正在主动关闭，等待对端确认 / 超时。
   - `FAILED`：协议错误或对端异常，唯一出口是显式关闭。
2. **消息状态（帧级）**：连接内处理一条消息时的解析进度。这是连接状态之下的子状态机，独立于连接宏观状态存在（一条消息的解析不改变连接状态；但可触发错误事件使连接进入 `FAILED`）。

设计规则：**连接状态决定「能不能收发」；消息状态决定「一条消息怎么被切成帧」。** 两者不可混用——把解析进度塞进连接状态会让状态数爆炸（连接的宏观状态 × 帧进度的笛卡尔积）。

## 事件

事件是驱动转移的输入，分三类：

- **输入事件**：来自对端的字节、消息、握手完成、对端关闭。
- **定时器事件**：请求超时、心跳超时、重传超时、慢启动/保活定时器。超时必须在协议里显式建模，不能只靠「阻塞读」隐式处理。
- **本地事件**：用户请求发送、主动关闭、错误检测（CRC 失败、长度非法、序列号错配）。

事件携带参数（如「解析进度」「错误原因」），但状态转移表只按「状态 × 事件类型」决定下一状态，参数只影响转移后的动作，不改变转移本身。这保证状态机可枚举、可测试。

## 状态转移

### 连接状态机

```text
CLOSED ──ev:listen/connect──► ESTABLISHING ──ev:handshake-ok──► ESTABLISHED
                                 │                              │
                                 │ ev:handshake-fail             │ ev:peer-close / ev:error
                                 ▼                              ▼
                              CLOSING ──ev:closed/fail──► FAILED ──► CLOSED
```

各转移必须覆盖的边界：

- `ESTABLISHING` 的超时（协商必须在 N 秒内完成，超时即失败）；
- `ESTABLISHED` 收到不可解析的消息 → `FAILED`（协议错误不恢复，见 protocol.md「错误路径不变量」）；
- `CLOSING` 等待对端关闭确认的超时；
- 任何状态收到错误事件都收敛到 `FAILED` → `CLOSED`，不允许「半可用」状态（protocol.md 错误路径不变量）。

### 帧状态机（消息解析）

TCP 是字节流，没有消息边界；所以「读一条完整消息」本身是一个小状态机。设计模板：

```text
READ_HEADER ──ev:header-complete──► READ_BODY ──ev:body-complete──► DISPATCH ──► READ_HEADER
    │                                  │                              │
    │ ev:header-invalid                 │ ev:len-exceeds-max           │ ev:unknown-type
    ▼                                  ▼                              ▼
  PROTOCOL_ERROR ─────────────────────► (连接进入 FAILED)
```

这个模式对任何「头 + 长度 + body」格式都成立：头解析完才知道 body 长度，body 读满才算一条消息。增量解析时，「头」可能横跨多次 recv，所以 `READ_HEADER` 状态要记住已读的头部字节数（见 resp_parser.c 的 `curr_location` 游标）。解析器每完成一条消息回到 `READ_HEADER`，天然支持流水线（多帧在缓冲中排队）。

若协议是「类型标签 + 回调」（如 RESP），`DISPATCH` 的下一状态实际上是「按类型跳转」的表驱动转移，而不是一排 if-else——这是把「解析策略」和「状态转移」分离的实践（`resp_parser.c:210` 的 switch 即此）。

### 组合原则

一个连接在任意时刻处于：**一个连接状态** 与 **一个帧状态** 的组合。设计时把两表分开写、分开测试；组合后的行为 = 连接状态决定收发的入口检查 + 帧状态决定解析。错误处理统一收敛到连接状态机的 `FAILED`。

## 正常 / 异常时序

以 `DemoP` 为例给出完整时序。

### DemoP 协议定义

- 传输：TCP，一次连接一个客户端。
- 握手：`MAGIC`（4 字节）+ `VER`（1 字节版本）+ `CAPS`（4 字节能力位），客户端先发，服务端以 `ACK/NAK` 回应。
- 消息：请求由「请求 ID（uint32） + 命令（1 字节） + 长度前缀（uint32） + body」组成；响应把命令字段替换为结果码（1 字节）。
- 错误：结果码 `0x00` 表示 OK，`0x01` 通用错误，`0x02` 权限错误，`0xFF` 协议错误。
- 版本：`VER=1` 只有命令 1；`VER=2` 新增命令 2 并设保留位。旧实现收到新命令返回「不支持」，不丢连接。

### 正常时序（一）

```text
Client                        Server
  |--- MAGIC|VER=2|CAPS --->    建立: ESTABLISHING
  |<--- ACK(VER=2) ------------ 协商交集: ESTABLISHED
  |--- REQ(id=1, cmd=1, body) ->
  |                            READ_HEADER -> READ_BODY -> DISPATCH
  |<--- RSP(id=1, code=0) ---- 回到 READ_HEADER
  |--- FIN ------------------> peer-close
  |<--- FIN_ACK --------------- CLOSING -> CLOSED
```

### 异常时序（协议错误 → 连接失败）

```text
Client                        Server
  |--- MAGIC|VER=1|CAPS --->
  |<--- ACK(VER=1) ----------- ESTABLISHED
  |--- REQ(id=1, cmd=2, body)-->    # VER=1 不认识 cmd=2
  |<--- RSP(id=1, code=0x01)---    # 报错但不丢连接（业务错误）
  |--- <损坏的帧，长度字段非法>--->  READ_HEADER: len > 上限
  |                             PROTOCOL_ERROR -> FAILED
  |--- (连接关闭, 半帧丢弃) ---->
```

时序要点：**业务错误返回错误码并保持 `ESTABLISHED`；解析/协议错误进入 `FAILED` 并关闭**。这是状态机设计里最容易混淆的一处，务必在状态表里区分错误类型。

## 处理流程（无显式状态机时）

RESP 的回复解析器没有显式状态机，但存在隐含的「游标状态」：`ReplyParser.curr_location` 指向当前未解析位置，`parseReply()` 每调用一次推进到下一个完整值（`resp_parser.h:86-90`，`resp_parser.c:210`）。其处理流程等价于帧状态机：

1. 读取当前游标处的第一个字符（类型标签）；
2. 按标签分发到对应 `parse*` 函数（`+`→`parseSimpleString`，`$`→`parseBulk`，`*`→`parseArray`……）；
3. 每个 `parse*` 内完成「找 `\r` → 读长度 → 推进游标」的原子操作（如 `parseBulk` 先跳过 `\r\n`，再按 bulklen 推进）；
4. 集合类型（array/set/map）回调要求调用方继续调用 `parseReply`，由调用方维护递归深度——即**递归帧状态机**。

读 RESP 源码时注意两点，它们是「无显式状态机」模式的普遍教训：

- 解析器只假设输入是**完整消息**；`parseReply` 不处理「半条消息在缓冲里」的增量场景（`resp_parser.c:52-55` 注释明确说明只解析 Redis 自身生成的回复、不做用户输入校验）——真实连接上的增量/半帧处理在 `networking.c` 的输入缓冲逻辑中，本项目未复制该文件，见 `src/README.md`。
- 递归深度 = 集合嵌套深度，无上限显式检查（`parseArray`/`parseMap` 都接受任意 `len`）；设计自定义协议时，应显式加上**嵌套深度上限**，防止恶意对端用深层嵌套触发栈溢出。