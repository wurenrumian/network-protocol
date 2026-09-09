# RDMA · state-machine

RDMA 的主要显式状态机有两个：**QP 状态机**（`ibv_qp_attr.qp_state`，语义来自 IB 规范，用户态在 `verbs.c:ibv_modify_qp` 推进）与 **RDMA CM 连接状态机**（分布在 `librdmacm/cma.c` 的事件分发与 `librdmacm/acm.c` 的解析流程）。前者是数据路径的端到端状态，后者是控制面会话进程。

## 一、QP 状态机

由 `ibv_modify_qp`（它内核执行真正的状态迁移）驱动，用户态 `verbs.c:717` 成功后在本地 `qp->state` 更新一致。状态值见 `enum ibv_qp_state`。

### 状态

| 状态 | 含义 |
| --- | --- |
| RESET | 初始；SQ/RQ 不可用，QP 不参与网络 |
| INIT | 允许 post RECV；禁止 SEND |
| RTR（Ready to Receive） | 可收；可 post RECV，不可发 |
| RTS（Ready to Send） | 可收可发（数据面装备完毕） |
| SQD（SQ Draining） | SQ 排空：允许在排空完成前修改 SQ 参数，再回 RTS |
| SQE（SQ Error） | SQ 出错（不可恢复），RQ 可继续使用 |
| ERROR | 错误态：QP 不可用，收发自纠停发 |

### 事件

| 事件 | 触发点 | 关键字段 |
| --- | --- | --- |
| MODIFY | `ibv_modify_qp` → 内核 | `attr.qp_state` + `attr_mask` |
| 数据路径错误 | 内核异步事件（`IBV_EVENT_QP_FATAL`、`QP_REQ_ERR`、`QP_ACCESS_ERR` 等）| 自动进入 ERROR |
| CQ 溢出 | `IBV_EVENT_CQ_ERR`（关联 QP 被 ERROR）| device.c:465 分发 |

### 状态转移（合法迁移）

```
                 (非法跳被内核拒绝：RESET 一步到 RTS 等)

 RESET ──modify──► INIT ──modify──► RTR ──modify──► RTS ──modify──► SQD ──modify──► ERROR
   ▲                 │                                     │   (排空后)      │
   │                 │                                     └──(修改 SQ 参数)─┘
   │                 ├──────────────────────────────────────────────────────► ERROR
   │                 │                    (SQ 错误)                          │
   │                 └── RTS ──(SQ 出错)──► SQE ─────────────────────────────► ERROR
   │                                                                            │
   └─────────────────(销毁重建)────────────────────────────────────────────────┘
```

具体地（由内核执行的合法规则，用户态 `ibv_modify_qp` 只是中转）：
- `RESET→INIT`：需要 `IBV_QP_PKEY_INDEX`、`IBV_QP_PORT`
- `INIT→RTR`：对 RC 需要 `IBV_QP_AV`、`PATH_MTU`、`DEST_QPN`、`RQ_PSN`、`MIN_RNR_TIMER`；对 UD 需要 `QKEY`
- `RTR→RTS`：需要 `IBV_QP_SQ_PSN`、`max_dest_rd_atomic`、`max_rd_atomic`
- `RTS→SQD→（排空后修改 SQ 参数）→回 RTS`；排空过程中可配置新的 SQ 参数
- 任意状态 → ERROR（最小 attr_mask 只要 `IBV_QP_STATE`）

**注意**：上表是简化模型。合法掩码依状态与 QP 类型而异；权威规则在 IB 规范 §9.2.1（QP State Transition 表）。用户态代码在这里只做中转（`ibv_modify_qp` 直接转发给 provider，`rxe.c` 的 `rxe_modify_qp` 即一层 `ibv_cmd_modify_qp` 转接），不做规则校验——完整的合法性决策在内核。

## 二、RDMA CM 连接状态机

RDMA 的 CM 是"类 socket"的四段：`id 生命周期 → 地址解析 → 连接建立 → 已建立`。用户态可见的是 `rdma_cm_event` 流与 `cma.c` 内的事件分发；真正的状态（`RDMA_CM_CONNECT`、`RDMA_CM_CONNECTING`…）管理在内核 `rdma_cm`，用户态在 `cma.c:2479 rdma_get_cm_event` 读取 `ucma_abi_event_resp.event`。

### 状态（用户态视角）

| 阶段（用户态可观察） | 含义 |
| --- | --- |
| IDLE | id 已创建（`rdma_create_id`/`rdma_bind_addr` 之后） |
| ADDR_RESOLVED | `rdma_resolve_addr` 成功 → 事件 `RDMA_CM_EVENT_ADDR_RESOLVED` |
| ROUTE_RESOLVED | `rdma_resolve_route` 成功 → `ROUTE_RESOLVED` |
| CONNECT（发起） | `rdma_connect` 发出 → 内核请求对方 |
| LISTEN（服务端） | `rdma_listen` 后等待 `CONNECT_REQUEST` |
| ESTABLISHED | 握手完成 → 用户收到 `EVENT_ESTABLISHED`（或 `CONNECT_RESPONSE`） |
| 拆除 | `rdma_disconnect` / 对方断开 → `EVENT_DISCONNECTED`，再 `rdma_destroy_id` |

### 事件（用户在 `rdma_get_cm_event` 收到）

内核 CM 事件映射见 `cma.c:2535-2570` 的 switch：

```
ADDR_RESOLVED → 后续服务端可发 resolve
ROUTE_RESOLVED
CONNECT_REQUEST（listen id 收到）
CONNECT_RESPONSE（内核对主动方，可含 ece）
ESTABLISHED
REJECTED  → 映射 errno（cma.c:1116）
DISCONNECTED
ADDR_ERROR / ROUTE_ERROR / CONNECT_ERROR / UNREACHABLE（负 status）
MULTICAST_JOIN / MULTICAST_ERROR
```

`ucma_process_conn_req`（cma.c:2298）：对 `CONNECT_REQUEST`，用户态为连接分配一个新的 `rdma_cm_id`（放在 `event.id`，原 listen id 在 `event.listen_id`），复制对方 `initiator_depth`/`responder_resources`，并查询对方请求信息；用户随后对这个新 id 调用 `rdma_accept`。

### 时序：主动方（client）

```
create_id → resolve_addr ─‑→ resolve_route ─‑→ [可 rdma_create_qp]
                                           │
                                           v
                           connect(...)   ── 内核 CM 握手开始 ─┐
                                           │                   │
  get_event: ADDR_RESOLVED · ROUTE_RESOLVED│ event=ESTABLISHED │◄── 握手完成
  （本地 resolve 异步完成时依次来）          └────────────────────┘
  之后 QP 已在 RTR/RTS（CM 自动调 ucma_modify_qp_rtr/rts）
```

- 客户端 connect 可先建 QP 也可后建；若后建，`rdma_connect` 时 `id->qp` 为 NULL，则 `qp_num` 用 0 表示"其后由服务方提供"（cma.c:1800-1805），随后在 `CONNECT_RESPONSE` 才补 QP。

### 时序：被动方（server）

```
rdma_create_id → rdma_bind_addr → rdma_listen(backlog)
     │（事件：RDMA_CM_EVENT_CONNECT_REQUEST 到达，取 new id）
     ▼
user: rdma_create_qp(对 request_id)  → 回调完成
     │
     ├─ 接受：rdma_accept(...)  ──► ESTABLISHED
     └─ 拒绝：rdma_reject(...)   ──► 对端 REJECTED
```

`rdma_establish`（cma.c:2467）：仅用于"尚未创建 QP"的连接（`id->qp == NULL`），它直接调用 `ucma_process_conn_resp` 让对方侧收到 ACCEPT，而不去 modify QP——这是"QP 由接收方事后创建"场景下，主动方手动完成握手的钩子。

### 事件处理保证（重要）

- `rdma_get_cm_event`（cma.c:2479）从 event channel 读 `ucma_abi_event_resp`，`resp.uid` 为 0 时的 fallback 用 `ucma_lookup_id(resp.id)`（cma.c:2521）以兼容旧内核未回填 uid 的 ESTABLISHED 事件。
- `rdma_ack_cm_event` 必须被调用，否则通道队列积压（每次 `ucma_complete` 前 ack 前一个 event，cma.c:1106-1108）。
- 对 `REJECTED`：`ucma_complete` 把它转成 `-ECONNREFUSED`（cma.c:1116）。

## 异常时序

| 场景 | 用户态可观察到 |
| --- | --- |
| resolve 超时 | `rdma_resolve_addr`/`route` 返回负 errno；事件 `ADDR_ERROR`/`ROUTE_ERROR` |
| connect 被拒绝 | `rdma_get_cm_event` 返回 `REJECTED`；`rdma_connect`（同步模式）直接返回 `-ECONNREFUSED` |
| 对端未监听 | `CONNECT_RESPONSE` status 为负 → 用户态按 `-ECONNREFUSED` 映射 |
| 断开 | `rdma_disconnect` 或对端关闭 → 事件 `DISCONNECTED`（cma.c:2586） |
| 不匹配（连接数多于 QP 配额 `max_responder_resources`） | RTR/RTS 修改时出错，连接失败 |
| 多线程竞争 | 用户需对 id 加锁；CM 内部 channel-fd 阻塞读 + 事件队列 |

## 处理流程（无显式状态机时）

acm.c 的地址解析不是状态机，而是"一条请求/应答消息闭环"：

```
ucma_ib_resolve（acm.c:322）
  → 打开 ACM unix socket（ucma_ib_init）
  → 构造 acm_msg（版本/opcode=ACM_OP_RESOLVE + ep_data：源/目的 IP、path_record）
  → send 单条消息 → recv 单条响应 → 校验 status/length
  → ucma_ib_save_resp 把 path/ip 写回 rdma_addrinfo
  → （RAI_ROUTEONLY 未设 & 有 path）→ ucma_resolve_af_ib 生成 AF_IB 地址
```

它的状态是"未连接 → 已连接"两段；无状态机，靠 `acm_lock` 全局锁序列化请求（acm.c:383-391）。

综上：**QP 状态机是数据面硬规则（非法迁移会被内核拒绝），CM 状态机是控制面逻辑（用户选择容错策略）**。