# 路由 / 转发 / NAT / Netfilter / Conntrack · state-machine

本文件记录本模块中**有显式状态机**的三处：BGP 会话 FSM（FRR `bgpd/bgp_fsm.c`）、OSPF 邻居状态机（FRR `ospfd/`）、conntrack 流状态（内核数据面）。RIP 与最长前缀匹配 / NAT 映射本身没有状态机，RIP 用定时器驱动的周期更新，NAT 映射用 conntrack 状态 + 超时管理，见 §"处理流程"。

## BGP 会话状态机（RFC 4271 §8.2，FRR `bgpd/bgp_fsm.c`）

### 状态

| 状态 | 含义 |
| --- | --- |
| Idle | 无连接，初始态；可配置为被动（等待）或主动（发起） |
| Connect | 主动连接被触发，正在发起 TCP 连接 |
| Active | 被动等待入站连接 |
| OpenSent | 已发送 OPEN，等待对端 OPEN |
| OpenConfirm | 收到对端 OPEN，等待 KEEPALIVE 确认 |
| Established | 双方 OPEN 与 KEEPALIVE 确认完成，可交换 UPDATE |

### 事件

| 事件 | 触发 | 主要来源 |
| --- | --- | --- |
| 启动 / ManualStart | 本地开启会话 | 配置 |
| TCP 连接成功 / 失败 | 主动方 Connect 完成或失败 | TCP |
| 收到 OPEN | 对端发起 | 报文 |
| 收到 KEEPALIVE | 对端确认 | 报文 |
| 收到 UPDATE | Established 后的路由通告 | 报文 |
| 定时器超时 | ConnectRetry / HoldTimer | 定时器 |
| 错误 / Notification | 本地或对端错误 | 事件 |

### 状态转移

```
Idle --ManualStart(主动)--> Connect --TCP连接成功--> OpenSent
Idle --配置为被动+TCP连接到来--> Active
Connect --ConnectRetry超时--> Connect（重试，退回 Idle 后可再发起）
Active --TCP连接到来--> OpenSent
OpenSent --收到对端OPEN--> OpenConfirm
OpenSent --HoldTimer超时--> Idle
OpenConfirm --收到KEEPALIVE--> Established
OpenConfirm --HoldTimer超时--> Idle
Established --HoldTimer超时 或 收到NOTIFICATION/错误--> Idle（断开TCP）
Established --收到UPDATE--> Established（处理路由通告，状态不变）
```

### 正常 / 异常时序

- **正常**：Idle →(主动) Connect → TCP 成功 → OpenSent → 收到 OPEN → OpenConfirm → 收到 KEEPALIVE → Established → 周期 KEEPALIVE 保活 + UPDATE 交换。
- **异常 1（对端不响应）**：OpenSent/OpenConfirm 中 HoldTimer 超时 → 回到 Idle，断开 TCP，下次重试。
- **异常 2（主动方先失败）**：Connect 失败 → 回到 Idle（或按 ConnectRetry 重试），不进入 OpenSent。
- **异常 3（协议错误）**：Established 中收到不合规 UPDATE / 对方主动 NOTIFICATION → 直接回 Idle；会话结束路径不经过中间状态。

## OSPF 邻居状态机（RFC 2328 §10，FRR `ospfd/ospf_packet.c` 驱动）

### 状态

| 状态 | 含义 |
| --- | --- |
| Down | 未发现邻居，未建立邻接 |
| Init | 收到过 Hello，但尚未双向确认 |
| 2-Way | 双向可见（双方都能看到对方），可开始数据库同步 |
| ExStart | 开始主从协商，确定谁先发送 DBD |
| ExChange | 交换数据库描述 / 链路状态请求，同步 LSA |
| Loading | 收到 LSU 请求但尚未完成（等待对端 LSU） |
| Full | 邻接完全建立，LSA 集合一致，定期 Hello 保活 |

### 事件

| 事件 | 触发 |
| --- | --- |
| Hello 到达 / 超时 | 报文 / 定时器 |
| 双向确认（2-Way） | 邻居状态机内部判断 |
| DBD / LSR / LSU / LS Ack | 报文 |
| 定时器（HelloInterval / LSRefresh） | 定时器 |

### 状态转移

```
Down --收到Hello--> Init
Init --双向可见--> 2-Way
2-Way --进入数据库同步--> ExStart
ExStart --主从协商完成--> ExChange
ExChange --LSR/LSU 完成--> Loading（等待对端完成）
Loading --对端 LSU 完成--> Full
Full --Hello超时--> Down（邻居丢失，删除其路由）
ExStart/ExChange/Loading --Hello超时--> Down
```

### 正常 / 异常时序

- **正常**：Down → Init → 2-Way → ExStart → ExChange → Loading → Full。Full 之后定期 Hello；拓扑变化用 LS 报文增量同步。
- **异常（邻居丢失）**：Full（或任何同步中状态）下 Hello 超时 → 直接回 Down → zebra 从 RIB 删除该邻居传播的路由。
- **主从协商失败**：ExStart 中协商超时 → 回 Down，重新从 Hello 开始。

## conntrack 流状态（Linux 内核，数据面）

### 状态

| 状态 | 含义 |
| --- | --- |
| NEW | 首包，流被识别但未被双向确认 |
| ESTABLISHED | 双向流量确认（TCP 握手完成 / UDP 双向包 / ICMP 应答） |
| RELATED | 由已有流派生的从属流（FTP data、ICMP 错误报文） |
| INVALID | 方向/端口/协议不匹配、或无法关联的包 |

### 事件与转移

```
NEW --同向+反向包确认--> ESTABLISHED
NEW --超时无反向--> 删除（NEW 不回 ESTABLISHED）
ESTABLISHED --关联新流--> RELATED（新流从 NEW/RELATED 开始）
任何状态 --规则/方向不匹配--> INVALID（记录但不升级）
ESTABLISHED/RELATED --会话超时--> 删除
```

### 正常 / 异常时序

- **正常（TCP）**：SYN 首包 → NEW；SYN-ACK 回来 → ESTABLISHED；后续数据保活；FIN/RST 或超时 → 删除。
- **正常（UDP）**：首包 → NEW；收到回包 → ESTABLISHED；单向持续 → 停留 NEW 直到超时删除。
- **异常**：只有单向流（如 UDP 半开放、被 RST 后的残留）→ 超时清理；NAT 多对一映射依赖 ESTABLISHED 状态在回包方向正确反向匹配。

## 处理流程（无显式状态机时）

- **RIP**：无状态机，纯定时器驱动——每 30s 发送完整 RIB 更新；收到更新后按距离向量比较，更短距离才更新条目；180s 无更新删除条目。
- **最长前缀匹配（数据面）**：无状态，每包独立：提取目的 IP → 在转发表按前缀位长降序匹配 → 命中则取出下一跳/出口接口，未命中则丢弃或走默认路由。
- **NAT 映射**：无独立状态机，映射生命周期由 conntrack 状态 + 绑定超时驱动：首包分配出口端点并建映射；会话 ESTABLISHED 期间保持；超时删除并回收出口端口。