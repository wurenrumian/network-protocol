# RDMA · protocol

RDMA 并非一个"报文协议"（wire protocol），而是一套**数据路径抽象 + 语义**。它把"把一段内存交给网卡收发"这件事实名化为若干对象（MR/QP/WR/WC/CQ），再在其上定义连接（RDMA CM）与传输语义（SEND/RECV、READ/WRITE）。因此本文按"问题 → 抽象 → 机制 → 取舍 → 不变量"组织，wire format 一节讲的是承载在 InfiniBand/RoCE 上的报文头如何与这些语义呼应。

## 问题定义

传统 TCP 收发路径中，主机 CPU 参与每一次数据移动：内核协议栈数据处理、copy_from/to_user、socket 缓冲、中断/调度。其代价有三：

1. **内核旁路缺失**：每次收发都经过内核，上下文切换与系统调用成为固定开销。
2. **多段拷贝**：应用缓冲 → 内核缓冲 → 网卡；接收反向再来一遍。零拷贝做不到跨主机。
3. **CPU 参与数据面**：数据移动和协议处理占用主机 CPU 周期，无法把 CPU 释放给应用。

RDMA 的目标是把**数据移动本身卸载给网卡**，而网卡通过"直接读写对端主机内存"完成传输。这带来三个直接能力：

- **单边操作（one-sided）**：本机只描述"对端哪里放/取数据"，对端 CPU 完全不参与数据移动（只有初始连接管理涉及 CPU）。
- **内核旁路**：post WR 之后，发送与完成都由网卡（或 RXE 的内核模块）处理，用户态无需再次进入系统调用。
- **低延迟**：每跳只有微秒级，端到端可到亚 10 微秒。

这个架构的代价是抽象复杂与控制面成本高：需要显式的内存注册、密钥（rkey）、可靠性协商，以及严格的 QP 状态机。

## 抽象对象

verbs 的核心对象都是"句柄 + 属性"，由 用户态（verbs 的 struct 包装）与内核（实际资源）共同构成。用户态对象保存句柄与少量元数据，内存注册、队列等都是内核资源的镜像。

| 对象 | 职责 | 关键字段/句柄 | 在管线中的位置 |
| --- | --- | --- | --- |
| `ibv_context` | 一个打开的设备实例，持 cmd_fd/async_fd | `ibv_get_device_list` → `ibv_open_device` 返回 | 万物之根，所有对象挂在 context 上 |
| `ibv_pd`（保护域） | 内存与队列的边界：一个 PD 内的 MR 才能被同 PD 的 QP 使用；也用于隔离 | `ibv_alloc_pd` | 访问控制点 |
| `ibv_mr`（MR） | 一段已注册、被网络可寻址的内存 | 返回 `lkey`（本地引用）与 `rkey`（远程读写密钥） | 数据落脚点 |
| `ibv_qp`（QP） | 队列对：发送队列 SQ + 接收队列 RQ | `qp_num` | 会话端点 |
| `ibv_send_wr` / `ibv_recv_wr`（WR） | 一次发送/接收请求：opcode + SGE 列表 + 附加信息 | 用户构造，任意时刻可 post | 命令入参 |
| `ibv_wc`（WC） | 完成状态：一次 WR 的结果 | `wr_id` 标识对应 WR，`status` 表示成败 | 完成回报 |
| `ibv_cq`（CQ） | 完成队列，存放 WC，供 poll/event 通知 | `ibv_create_cq` | 异步完成汇聚点 |
| `ibv_ah`（AH） | 地址向量：编码目标 GID/SL/PKEY 等，一次发送的目的描述 | `ibv_create_ah` / `ibv_create_ah_from_wc` | 无连接（UD）发送寻址 |
| `rdma_cm_id` | RDMA CM 的连接标识，类比 socket fd | 绑定 QP 与地址 | 连接管理 |

要点：

- QP 是**双向**的：SQ 对应发送（SEND/RDMA WRITE/READ 等），RQ 对应接收（RECEIVE）。CQ 可以是一个（收发共用）或多个。
- MR 与 PD 的关系是**强制不变性**：QP 只能引用与其同 PD 的 MR 的 rkey。这构成"谁有权限看到谁的内存"的边界。
- AH 主要出现在无连接（UD/QP）场景；连接型（RC）的 QP 已在建连时固定了对端，无需每次发送带 AH。

## wire format

RDMA verbs API **没有自己的控制面报文**：连接管理走 RDMA CM（一个独立的 CM 控制面协议），而数据不是"报文"而是对内存的操作指令。下面的 wire 语义来自两份规范（详见 references.md）：

### verbs 控制面：ioctl 到内核（`/dev/infiniband/uverbsN`）

- `libibverbs` 通过 `write()` 系统调用把命令 `ibv_cmd_*` 结构体发往 `cmd_fd`（`device.c` 的 `open_cdev` 打开），如 `IB_USER_VERBS_CMD_POST_SEND`、`IB_USER_VERBS_CMD_REG_MR`、`IB_USER_VERBS_CMD_POLL_CQ`、`IB_USER_VERBS_CMD_MODIFY_QP`（见 `cmd.c` 的 `execute_cmd_write*`）。
- 这些 ioctl/命令承载的对象 `handle`（如 `cmd->qp_handle`）和写回缓冲区，是 RDMA "线下" 的控制面命令格式——不同于网络上的报文。RDMA CM 对内核还有独立的 `rdma_ucm` 通道（`cma.c` 中的 `CMA_INIT_CMD*` 事实上都是对 channel->fd 的 `write`，如 `CONNECT`、`RESOLVE_ADDR`、`LISTEN` 等）。

### 数据面：InfiniBand 与 RoCE 报文

RDMA 的数据面报文本上是 InfiniBand（写）报文格式，RoCE 把它封装进以太网：

- **IB 报文（IB 规范）**：报文由数据包与确认对构成（RC 可靠连接）。头部序列：LRH（链路路由头，含源/目的 LID）、GRH（Global Routing Header，40 字节，含 SGID/DGID、flow label/traffic class）、BTH（Base Transport Header，含 QPN、PSN、opcode）、扩展传输头（RETH 含远程地址与 rkey；原子操作头）、数据载荷与 CRC。
- **RoCEv1/v2**：以 UDP 或以太网 II 封装来承载 IB 报文：
  - RoCEv1：IB 的 GRH（含 16 字节 SGID/DGID，即 IPv6 形式地址）直接封装在 Ethernet II 帧内，无 IP/UDP 层。
  - RoCEv2：把 GRH 的字段映射进 IPv4/IPv6 + UDP 头，固定 UDP 端口 4791，GID 即 IP 地址；适合传统 L3 网络。
- AH 的关键作用正在这里：**从 `ibv_ah_attr`（含 SGID/DGID）推导出目标 MAC/IP 地址**，`ibv_create_ah_from_wc`、`ibv_resolve_eth_l2_from_gid`（verbs.c:1031）在代码里执行 L2/L3 解析。对 RoCEv2，AH 需要 IP+UDP 头，因此 AH 创建可能需要做 ARP/邻居解析。

这些报文的**构造与解析是在内核/RXE 中完成的**（用户态 rxe.c 的 `rxe_create_ah` 只负责把 AH 的字段传到内核），用户态只能看到 `rxe.c` 中 `post_send_db` 之后由内核写回 WC 的完成队列。因此本模块把 wire format 视为"语义指导"，详细头字段请转向 `references.md` 的 IB/RoCE 规范章节。

## 核心机制

### 1. 内存注册（MR）

一切数据移动的起点：把一段用户虚拟内存注册给设备（pin 页、建映射），获得对网卡的可见性与访问授权。

```text
ibv_reg_mr(pd, addr, length, access)
  → verbs.c:310 ibv_reg_mr_iova2
  → get_ops(pd)->reg_mr()
  → rxe.c:209 rxe_reg_mr → ibv_cmd_reg_mr → REG_MR ioctl
  → 内核负责 pin 页、生成 lkey/rkey
```

- 返回 `struct ibv_mr`，携带 `handle` + `lkey/rkey`（verbs.c:324-329 填充 mr 的 addr/length/pd）。
- `access` 是权限位（`IBV_ACCESS_LOCAL_WRITE|REMOTE_READ|REMOTE_WRITE|REMOTE_ATOMIC` 等），由内核强制检查远端 rkey。
- RXE 里 `next_rkey`（rxe.c:165）演示了 rkey 的生成与应用内管理。
- 关键不变量：**注册期间内存不能被换页/释放**（`ibv_dontfork_range`/`ibv_dofork_range`，verbs.c:320-331 处理 fork 后地址空间变化）。

### 2. QP 生命周期

QP 是传输端点，先建后改（modify）才能进入可用状态。完整状态机见 `state-machine.md`。此处只列出关键 step：

```c
ibv_create_qp(pd, init_attr)      → 内核创建 QP，返回 qp_num
ibv_modify_qp(qp, attr, mask) ::  RESET→INIT→RTR→RTS  // 每步带不同 attr_mask
   cma.c: ucma_modify_qp_rtr / ucma_modify_qp_rts   ← CM 助攻
ibv_destroy_qp(qp)
```

- `ibv_modify_qp`（verbs.c:717）在成功后将 `qp->state` 更新为 `attr->qp_state`。
- RTR/RTS 的参数（max_dest_rd_atomic、max_rd_atomic、sq_psn 等）由 `rdma_init_qp_attr`（cma.c:1277-1320）从 CM 上下文代入：说明 QP 参数实际上由连接信息决定。

### 3. WR → CQ 异步完成

核心环路（数据路径）是最关键的闭环：

```c
用户构造 ibv_send_wr（opcode + sge 数组）
  → ibv_cmd_post_send（cmd.c:603）：
       遍历链，把每个 WR 序列化为 ib_uverbs_send_wr —— opcode/send_flags/imm_data、
       per-opcode 字段（RDMA 的 remote_addr/rkey、atomic 的 addr/rkey/compare 等）拷进命令缓冲
       → execute_cmd_write(IB_USER_VERBS_CMD_POST_SEND)
  在 rxe 库中：
  → rxe_post_send（rxe.c:1656）：
       while(wr_list) { post_one_send(...) }  → 把 WR 写入与内核共享的 SQ 环形队列（producer/consumer）
       → post_send_db()（rxe.c:1633）发一个空 post_send 做 doorbell 通知内核
  内核完成后：
     把 ibv_wc 写回共享完成队列
  → ibv_cmd_poll_cq（cmd.c:194）或 rxe_poll_cq（rxe.c:555）
  → 应用读 ibv_wc 拿回 wr_id 与完成状态
```

- 发送路径是**环形队列 + 用户态入队 + 一次门铃**：WR 写入与内核共享的 mmap 队列，一次 write 通知内核取走。
- 完成路径是**内核写 tail、用户 poll 读 head**（`rxe_poll_cq` 的 `consumer_addr`/`advance_consumer`），是经典的 producer/consumer。
- CQ 通知：默认轮询（poll）+ 可选的 `ibv_req_notify_cq`（cmd.c:240）产生 `comp_event`，再 `ibv_get_cq_event`（verbs.c:587）读到 fd；`ibv_ack_cq_events` 归还事件借据（verbs.c:605）。comp channel（`ibv_create_comp_channel`，verbs.c:498）绑定到 CQ，可配合 poll/epoll 等事件循环。

### 4. SEND/RECV 与 READ/WRITE 语义

四种操作是 RDMA 的两根轴——**拷贝式（主人操作）**与**远程访问式（内存操作）**：

| 操作 | WR 方式 | 数据移动 | CPU 参与 | 可靠性 | 对端 |
| --- | --- | --- | --- | --- | --- |
| SEND | 发送队列 SQ | 本方 SGE → 对端预先 post 的 RECV 缓冲区 | 双方 CPU（发送方送，接收方先 post RECV） | RC：可靠 | 需对端预布 RECV |
| RECV | 接收队列 RQ | SEND 的数据落到预先 post 的 RECV SGE | 接收方应用 post RECV | RC：可靠 | 对端发 SEND |
| RDMA WRITE | 发送队列 SQ | 本方 SGE → 对端已注册的远程内存（凭 rkey） | 仅发送方 | RC：可靠；UC/UD：不可靠 | 无需对端 CPU，只要求 rkey 授权 |
| RDMA READ | 发送队列 SQ | 对端内存 → 本方 SGE | 仅发送方 | RC：可靠 | 对端只需提供 rkey + REMOTE_READ |

编码在 `cmd.c` 的 `ibv_cmd_post_send` 的 per-opcode switch：

```c
case IBV_WR_SEND:                  // 无 remote 信息，发送方只给本地 SGE
case IBV_WR_RDMA_WRITE/READ:       // 拷贝 remote_addr + rkey
case IBV_WR_ATOMIC_*:              // 拷贝 remote_addr + rkey + compare/swap
```

- **SEND/RECV 是双方协同**：接收方必须提前把 RECV 的 SGE post 进 RQ，否则到达的 SEND 会让 QP 报错。
- **READ/WRITE 是单向发起**：只有发送方把"去对端哪、读/写多少、用什么 rkey"告诉网卡，对端 CPU 全程不参与数据移动。这是"零 CPU 拷贝"的根源。
- 这两类可以合在同一 SQ 中 post（排队自然有序），且 RC 下完成顺序与 post 顺序严格一致（可靠按序交付）。

### 5. RDMA CM 建连

`librdmacm` 把 RDMA 会话建模成"类 socket"：

```
（主动方）                        （被动方）
rdma_create_id(..., RDMA_PS_TCP)
    │
    v
rdma_resolve_addr(src?, dst, timeout)    rdma_create_id / rdma_bind_addr
    │                                        │  （能解析, 先 bind）
    v                                          v
rdma_resolve_route                rdma_listen(backlog)  → 事件：CONNECT_REQUEST
    │                                        │（被动方在其中 rdma_accept）
    v                                        v
rdma_create_qp(可选，或由 accept 端创建) ←───────────────────┤
    │                                        │
    v                                        │
rdma_connect(...) ───── 内核 CM 开始握手 ───────► accept → RDMA CM 握手完成
    │                                        │
    v                                        v
rdma_get_cm_event：ADDR_RESOLVED→ROUTE_RESOLVED→ESTABLISHED
```

- 内核侧：CM 握手分为独立的控制面（`addr`/`route` 解析 + `connect`/`accept`），建连完成后 **QP 才真正置为 RTR/RTS**（`ucma_modify_qp_rtr` / `ucma_modify_qp_rts`，cma.c:1267/1307）。
- 用户的 `rdma_conn_param`（`initiator_depth`/`responder_resources` 等）被序列化到 `ucma_abi_connect`（cma.c:1807 `ucma_copy_conn_param_to_kern`）进内核一侧持久。
- 事件模型：`rdma_get_cm_event`（cma.c:2479）从 event channel fd 读 `ucma_abi_event_resp`，按 `resp.event` 分发给用户；`rdma_ack_cm_event` 释放。`rdma_establish`（cma.c:2467）用于"尚未创建 QP"的连接，主动方手动让对方收到 ACCEPT 完成握手。

### 6. RoCE/InfiniBand 与以太网封装

- **InfiniBand（原生）**：报文在一个子网（subnet）里运行，每 port 有 16 字节 GID（由 SM 分配）+ 16 位 LID。连接决策用 `rdma_addrinfo`（经 ACM 消息，调用 `ucma_ib_resolve`，acm.c:322 构造 `acm_msg`/`ibv_path_record` 发给 ACM 守护进程解析）。
- **RoCE**：同一 GID 现在是 IPv6（RoCEv1）/ IPv4 地址（RoCEv2）+ 一个固定 UDP 端口（4791）。因此 **AH 的内容负责把 GID 解析成目的 MAC/IP**。关键绑定点在 `verbs.c` 的 `ibv_resolve_eth_l2_from_gid`（verbs.c:1031），它把 RoCE 的 GID 转化为目标 MAC（对 RoCEv2 走 IPv4→ARP/邻居）。
- 对应用透明的主要差异：**MTU/PMTU、链路层/物理层、subnet manager** 等。`verbs.c` 中的 `ibv_query_gid_type`（verbs.c:755）区分 IB 与 RoCE GID 类型。

## 设计取舍（与 TCP / 内核路径对比）

| 维度 | TCP（内核 socket） | RDMA |
| --- | --- | --- |
| 参与拷贝的 CPU | 两端 CPU（协议处理+拷贝） | 由网卡/驱动完成（RAW 数据移动不占主机 CPU） |
| 缓冲区所有权 | 内核 owns 数据 | **用户 owns 数据**：只有注册的内存可访问，数据路径零中间拷贝 |
| 可靠性 | TCP 软件重传/流控 | RDMA 语义：RC 在硬件/驱动里做 PSN 检查、重试；UC 不可靠；UD 尽力 |
| 连接模型 | listen/accept/connect | RDMA CM 的方法同构 |
| 流控 | 内核拥塞控制（cwnd） | 硬/驱动级 credit（`max_dest_rd_atomic` 的原子资源）——不面向应用 |
| 自适应拓扑 | 任意 IP 相互 | 需要 L2/L3 可达（RoCE）或 IB subnet |
| 安全模型 | 内核隔离 socket 权限 | **rkey 隔离**：remote access 由 rkey 保护，MR 授权显式 |

取舍的核心是：**用控面复杂换取数据面简单（和低延迟）**。RDMA 不做流量整形的用户面处理，把可靠性与流控打进硬件/驱动，换来 CPU 可扩展性。

## 不变量

1. **同一 PD 才可见**：WR 中的 MR 必须与 QP 同 PD；跨 PD 属于非法引用。
2. **RQ 先 post RECV**：一个 SEND 的数据只能落到预先存在的 RECV；没有 RECV 时，RC 报错、UD 会丢。
3. **WR 在 post 之后即由硬件负责**：完成事件（WC）对 RC 与 post 顺序严格一致；同 SQ 的多个 WR 也按序提交。
4. **内存注册期间地址不变**：MR 存活期间该虚拟页面不能换出/释放。
5. **CQ 的 poll/done 是 EOF 计数**：poll 只返回值少于请求暗示 —— 不能以"返回几"判断错误；必须检查 wc.status == IBV_WC_SUCCESS。
6. **破坏之后不可复用数据传输**：QP 一旦进 ERROR，不可再从它收发（除非用户重新创建），**不可回到 RTS**。
7. **完成事件必须 ACK**：`ibv_ack_cq_events` 之前，comp channel 的事件数为 0；事件不会自动重新过期。

## 边界条件与异常处理

| 场景 | 行为 | 源码位置 |
| --- | --- | --- |
| QP 数据路径错误（无 RECV、rkey 越权等） | 内核发异步事件（`QP_FATAL`/`QP_REQ_ERR`/`QP_ACCESS_ERR`），`ibv_get_async_event` 读回 | device.c:470-474 |
| post 的 WR 超 max_inline 或无效 opcode | `post_send` 返回错误，`bad_wr` 指向第一个坏 WR | cmd.c:603、rxe.c:1656 `validate_send_wr`（1460） |
| CQ 队列满（completion overflow） | 该 CQ 关联的 QP 被置 ERROR；`IBV_EVENT_CQ_ERR` 异步事件 | device.c:465 |
| `num_sge > max_sge` / 非法地址 | post 时报 EINVAL | rxe.c:1466 |
| QP 处于 RESET（或未 RTS）时 post | post_recv 直接返回 EINVAL（C10-97.2.1 注释）| rxe.c:1707-1709 |
| CM 握手失败 | resolving / connect 返回负 errno；REJECTED 映射为 `-ECONNREFUSED` | `ucma_complete`（cma.c:1097）、cma.c:1116 |
| `rdma_listen` 占用重复地址 | 返回 `-EADDRINUSE` | 内核 ucm side |
| fork 后注册内存 | `ibv_dontfork_range` 负责重新注册或失败 | verbs.c:320 |
| WC status = CONN_RESET / REMOTE_ACCESS_ERR | RDMA READ/WRITE 因 rkey 无权限、地址错 | 错误 wc |
| 未消费的完成事件 | `ibv_get_cq_event` 阻塞至有事件；须 `ibv_ack_cq_events` 归还借据，否则持续积压 | verbs.c:587/605 |

任何 `ibv_modify_qp` 的 attr_mask 或 attr 非法（如 RESET 一步直接跳 RTR 且缺参数、给 UD 传 RC 专属 mask）在内核侧由通用验证拒绝，返回 `-EINVAL`（`cmd.c` 的 `ibv_cmd_modify_qp` 只做序列化）。