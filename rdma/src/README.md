# RDMA · src

本页只做源码导航：上游版本、文件清单、阅读顺序、入口/结束函数、依赖说明。协议语义见 `../protocol.md` 与 `../state-machine.md`。

## 上游版本

| 项 | 值 |
| --- | --- |
| 仓库 | `github.com/linux-rdma/rdma-core` |
| 固定 tag | `v49.0` |
| commit | `7e813ec60153061260ddfb216f4633b55ca4e99a` |
| 获取方式 | `curl https://raw.githubusercontent.com/linux-rdma/rdma-core/v49.0/<path>` |
| 目录 | `src/upstream/`（保留相对路径）、`src/LICENSES/`（许可证） |

## 文件清单（文件 → 类别 → 阅读范围）

以 `src/upstream/` 为根。

### libibverbs/ —— 核心 verbs API（core）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `libibverbs/verbs.c` | core（API 实现） | 全文：`ibv_reg_mr*`（MR）、`ibv_create_cq`/`ibv_get_cq_event`/`ibv_ack_cq_events`（CQ 与完成事件）、`ibv_create_qp`/`ibv_modify_qp`/`ibv_query_qp`（QP 生命周期）、`ibv_create_ah`/`ibv_create_ah_from_wc`/`ibv_resolve_eth_l2_from_gid`（AH 与 RoCE 寻址）、`ibv_query_gid*` |
| `libibverbs/device.c` | integration（设备发现/打开）+ platform（fd/context） | `ibv_get_device_list`（枚举）、`verbs_open_device`/`ibv_open_device`（打开与 cmd_fd/async_fd）、`set_lib_ops`（把库 ops 表注入 context）、`verbs_init_cq`（CQ 初始化与 comp channel 引用计数）、`ibv_close_device`/`ibv_get_async_event` |
| `libibverbs/cmd.c` | core（命令序列化） | `ibv_cmd_reg_mr`（MR 命令）、`ibv_cmd_modify_qp*`（QP 状态迁移命令）、`ibv_cmd_post_send`/`ibv_cmd_post_recv`/`ibv_cmd_poll_cq`/`ibv_cmd_req_notify_cq`（数据路径与 CQ）、`ibv_cmd_create_ah` 等；其余（SRQ/XRC/mw/flow）可跳过 |

### librdmacm/ —— 连接管理（integration）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `librdmacm/cma.c` | integration（RDMA CM 控制面）+ core（CM 事件状态机） | `rdma_create_id`/`rdma_bind_addr`/`rdma_resolve_addr`/`rdma_resolve_route`（id 与地址）、`rdma_create_qp`、`rdma_listen`/`rdma_accept`/`rdma_connect`/`rdma_reject`（建连）、`rdma_get_cm_event`/`rdma_ack_cm_event`/`rdma_establish`/`rdma_disconnect`/`rdma_destroy_id`（事件与拆除）、`ucma_modify_qp_rtr/rts`（QP 在 CM 里的推进） |
| `librdmacm/acm.c` | integration（地址解析到 ACM daemon） | `ucma_ib_init`（打开 ACM socket）、`ucma_ib_resolve`（构造 acm_msg 请求/响应）、`ucma_ib_save_resp`、`ucma_set_ep_addr`/`ucma_ib_addr`（sockaddr ↔ acm ep 数据） |
| `librdmacm/preload.c` | platform（LD_PRELOAD 对 socket API 的拦截） | 可跳过或只读 `socket`/`connect`/`send`/`recv`/`poll` 的拦截分支：体会"把普通 socket 透明转成 RDMA socket"的思路 |

### providers/rxe/ —— Soft-RoCE 数据路径（core + platform）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `providers/rxe/rxe.c` | core（QP/队列语义）+ platform（ioctl/mmap 到内核） | `rxe_reg_mr`（MR）、`rxe_create_cq`/`rxe_poll_cq`（CQ 与队列消费）、`rxe_create_qp`/`rxe_modify_qp`（QP 创建与状态迁移转发）、`rxe_post_send`/`rxe_post_recv`/`post_one_send`/`post_send_db`/`validate_send_wr`（SQ/RQ 环形队列 + 门铃）、`rxe_create_ah`（AH）、`rxe_alloc_context`/`rxe_ctx_ops` 表（provider 注册） |

## 阅读顺序与调用链

按 `protocol-learning-design.md` §4.7：MR → QP → WR/WC → CQ → RDMA CM → SEND/RECV → READ/WRITE → RoCE/InfiniBand。对每个主题串一条最小闭环。

### 1. MR（内存注册）

```
ibv_reg_mr(pd, addr, len, access)          verbs.c:338
  → ibv_reg_mr_iova2                       verbs.c:310 （dontfork 保护 → get_ops()->reg_mr）
  → rxe_reg_mr                             rxe.c:209
  → ibv_cmd_reg_mr                         cmd.c:99   （写 IB_USER_VERBS_CMD_REG_MR 到 cmd_fd）
  → 内核 pin 页并回填 lkey/rkey（在 rxe.c:221 的 resp 中）
```

### 2. QP 生命周期

```
ibv_create_qp(pd, init_attr)               verbs.c:658
  → rxe_create_qp                          rxe.c:1238 （ibv_cmd_create_qp + map_queue_pair 映射 SQ/RQ 环）
ibv_modify_qp(qp, attr, mask)              verbs.c:717
  → rxe_modify_qp                          rxe.c:1433 → ibv_cmd_modify_qp（cmd.c:566）
  → 内核按 RESET→INIT→RTR→RTS 推进（用户态只更新 qp->state）
  （CM 辅助：cma.c:ucma_modify_qp_rtr / rts）
ibv_destroy_qp                             verbs.c:734
```

### 3. WR → WC（数据路径核心闭环）

```
ibv_cmd_post_send(qp, wr_list, bad_wr)     cmd.c:603
  ├─ 遍历 WR：计算 wr_count/sge_count，序列化 per-opcode 字段（remote_addr/rkey/atomic）
  └─ execute_cmd_write(IB_USER_VERBS_CMD_POST_SEND)
      （对 rxe 走 rxe_post_send：post_one_send 写入 SQ 环 + post_send_db 门铃）  rxe.c:1656/1595/1633
完成返回：
  rxe_poll_cq / ibv_cmd_poll_cq            rxe.c:555 / cmd.c:194
  （环形队列 consumer 头推进，读 ibv_wc）
  可选通知：ibv_req_notify_cq → ibv_get_cq_event → ibv_ack_cq_events
             cmd.c:240 / verbs.c:587 / verbs.c:605
```

### 4. RDMA CM 建连

```
（client）                                  （server）
rdma_create_id                  │ rdma_create_id → rdma_bind_addr
  cma.c:792                     │
rdma_resolve_addr  cma.c:1151   │ rdma_listen(backlog)      cma.c:1824
rdma_resolve_route cma.c:1213   │   ├─ CONNECT_REQUEST 事件  cma.c:2536/2298
rdma_create_qp     cma.c:1693   │   ├─ rdma_accept            cma.c:1905
rdma_connect       cma.c:1778 ──┼──► (ucma_modify_qp_rtr/rts)
  │                             │
rdma_get_cm_event  cma.c:2479 ◄─┼──► rdma_get_cm_event
  （ESTABLISHED）                （ESTABLISHED）
之后进入数据面：SEND/RECV / READ/WRITE 走第 3 步的闭环
```

### 5. SEND/RECV 与 READ/WRITE 的差异点

回到 `cmd.c:ibv_cmd_post_send` 的 per-opcode switch（cmd.c:620-646）：

- SEND/RECV：发送方用 `IBV_WR_SEND`（不需要 remote 信息），接收方 `ibv_post_recv` 预先布置 RQ SGE；`ibv_cmd_post_recv`（cmd.c:691）只传 sge 与 wr_id。
- RDMA WRITE/READ：发送方 WR 里带 `wr.rdma.remote_addr` + `wr.rdma.rkey`（cmd.c:632-638）。rkey 指向对端已注册 MR（REMOTE_WRITE/REMOTE_READ 授权）。这是"单边操作"的编码位置。

### 6. RoCE / InfiniBand 寻址

```
ibv_create_ah_from_wc / ibv_create_ah      verbs.c:963 / 741
  → 内核用 AH 头（含 SGID/DGID）
ibv_resolve_eth_l2_from_gid                verbs.c:1031 （RoCE：GID→MAC/IP）
ibv_query_gid_type                         verbs.c:755  （区分 IB 与 RoCE GID）
地址解析来源：librdmacm/acm.c:ucma_ib_resolve（ACM daemon 返回 path_record → AF_IB 地址）
```

## 入口函数 / 结束函数

| 主题 | 入口 | 结束 |
| --- | --- | --- |
| 设备打开 | `ibv_get_device_list`（device.c:54）→ `ibv_open_device`（device.c:363） | `ibv_close_device`（device.c:442） |
| MR | `ibv_reg_mr`（verbs.c:338） | `ibv_dereg_mr`（verbs.c:481） |
| QP | `ibv_create_qp`（verbs.c:658） | `ibv_destroy_qp`（verbs.c:734） |
| CQ | `ibv_create_cq`（verbs.c:545） | `ibv_destroy_cq`（verbs.c:567） |
| 发送/接收 | `ibv_post_send`/`ibv_post_recv`（verbs.h inline → `ops` 表） | 完成在 CQ（`ibv_poll_cq` → `rxe_poll_cq` rxe.c:555 / `ibv_cmd_poll_cq` cmd.c:194） |
| CM（主动） | `rdma_create_id`（cma.c:792） | `rdma_destroy_id`（cma.c:821） |
| CM（服务） | `rdma_listen`（cma.c:1824） | `rdma_destroy_id` |
| 事件 | `rdma_get_cm_event`（cma.c:2479） | `rdma_ack_cm_event`（cma.c:2230） |

> 注：`ibv_post_send`/`ibv_post_recv`/`ibv_poll_cq`/`ibv_req_notify_cq` 是 `libibverbs/verbs.h` 中的 `static inline`，直接分发到 `context->ops.post_send/poll_cq/...`（即 `rxe_ctx_ops` 表，rxe.c:1826）。本仓库未复制 `verbs.h`，对应实现落在 `cmd.c` 的 `ibv_cmd_*` 与 `rxe.c` 的 `rxe_post_*`/`rxe_poll_cq`。`verbs.c` 中 `LATEST_SYMVER_FUNC` 宏展开后是符号出口。

## 未复制的依赖

| 依赖 | 角色 | 如何补看 |
| --- | --- | --- |
| `libibverbs/{verbs.h,common.h,driver.h,ibverbs.h,libibverbs.h}` | 类型定义、`verbs_context_ops` 表、`get_ops`/`verbs_get_device` 宏、`ibv_post_send`/`ibv_poll_cq` 等 inline 分发函数 | 按需从 `libibverbs/` 复制 |
| `librdmacm/{cma.h,rdma_cma.h,rsocket.h,addrinfo.h}` | `struct rdma_cm_id`、`rdma_conn_param`、`rdma_addrinfo` 定义 | 从 `librdmacm/include/` 取 |
| `libibverbs/init.c` | `ibverbs_init`/`ibverbs_get_device_list`/`open_cdev`（device.c 中引用） | 了解设备发现走 sysfs + `dlopen` provider `.so` |
| Linux 内核 `uverbs`/`rdma_cm` | ioctl 接收端、QP 状态机内核规则、数据面（rxe 内核模块） | 内核源码 `drivers/infiniband/`，`rdma-core` 仓库的 `kernel/` 子目录有镜像 |
| `providers/rxe/{rxe-verbs.h,rxe-queue.h,rxe.h}` 及内核 RXE | `struct rxe_qp/rxe_wq`、`urxe_*_resp`、队列 `producer/consumer` 宏 | 本次只读 `rxe.c`，需要时补内核 RXE |
| 构建/头文件脚手架（`config.h`、`infiniband/kern-abi.h` 等） | 编译依赖 | 不阅读 |

## 已复制 / 跳过说明

- 已复制：`libibverbs/{verbs.c,device.c,cmd.c}`、`librdmacm/{cma.c,acm.c,preload.c}`、`providers/rxe/rxe.c`，共 7 个源文件，全部从 tag `v49.0` 原样拉取，未做改动。
- 跳过：所有 `.h`（含 `verbs.h` 中的 inline 分发函数）、rsocket、`*.sym`、构建与测试文件；其职责见上表"未复制的依赖"。
- 许可证：`src/LICENSES/` 存放 `COPYING.md`（默认双许可说明）、`COPYING.BSD_MIT`、`COPYING.GPL2`。文件头部若标注双许可的，二选一；标"See COPYING file"的遵默许。