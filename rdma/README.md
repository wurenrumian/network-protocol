# RDMA

## 定位

RDMA（Remote Direct Memory Access）是"高性能网络"路线的终点之一，解决的是 CPU 拷贝与内核路径开销问题：让网卡硬件直接读写对端主机的内存，应用程序绕过内核协议栈与中间缓冲，达到微秒级端到端延迟。

本模块以 rdma-core 的用户态库（`libibverbs` 提供 verbs 抽象，`librdmacm` 提供连接管理）为主实现，配合 Soft-RoCE（RXE）providers 阅读数据路径与队列语义，不涉及驱动硬件寄存器与固件细节。阅读目标是回答：

- verbs 抽象了哪些对象（MR/QP/WR/WC/CQ/PD/AH），它们之间如何组合成一条数据路径；
- 为什么"发送数据"被拆成 post WR → 硬件取数据 → 完成进 CQ 的异步闭环；
- RDMA CM 如何复用 socket 的连接思维（listen/connect/accept）管理 RDMA 会话；
- SEND/RECV 与 READ/WRITE 在语义和可靠性上的差异；
- RoCE 如何在以太网上承载 InfiniBand 报文，与纯 InfiniBand 的区别。

## 前置模块

按根目录 `protocol-learning-design.md` §4 的主干顺序，进入 RDMA 前建议已有：

- **UDP / TCP**：理解传输层建连、可靠性与流控，用于与 RDMA CM 和可靠连接（RC）对比。
- **事件循环与 I/O（epoll / io_uring）**：CQ 完成事件 + 多路复用的机制来自同样的异步模型。
- **用户态高速包处理（DPDK）**：理解"内核旁路 + 轮询"的延迟来源，RDMA 是同一路线的收尾。
- **Ethernet / IP**：RoCE 的 L2/L3 头与 GID 解析建立在其上。

## 推荐阅读顺序

按 `protocol-learning-design.md` §4.7：MR → QP → WR/WC → CQ → RDMA CM → SEND/RECV → READ/WRITE → RoCE/InfiniBand。

具体步骤：

1. `protocol.md`：先建立对象与语义的整体图景（不读代码）。
2. 内存注册：`verbs.c` 的 `ibv_reg_mr` → `rxe.c` 的 `rxe_reg_mr`（MR 是什么、rkey 从哪来）。
3. QP 生命周期：`verbs.c` 的 `ibv_create_qp` / `ibv_modify_qp` → `rxe.c` 的 `rxe_create_qp` / `rxe_modify_qp`，配合 `state-machine.md` 的状态机。
4. WR/WC 与 CQ：`cmd.c` 的 `ibv_cmd_post_send`/`ibv_cmd_poll_cq` 的数据组装 → `rxe.c` 的 `rxe_post_send`/`rxe_poll_cq` 的入队与完成。
5. RDMA CM：`cma.c` 的 `rdma_create_id` → `rdma_resolve_addr` → `rdma_connect`/`rdma_listen`/`rdma_accept` → `rdma_get_cm_event`，配合 `state-machine.md`。
6. SEND/RECV vs READ/WRITE：回到 WR 的 opcode 与 `cmd.c` 中 per-opcode 字段序列化（`remote_addr`/`rkey` 出现的位置）。
7. RoCE/InfiniBand：`acm.c` 的路径记录（`ibv_path_record`）与 `rxe.c` 的 `rxe_create_ah`，理解 AH 如何编码 GID/SGID → 以太网头。
8. 再读 `src/README.md` 的调用链，把各步骤串成一条完整闭环。

## 源码入口

指向 `src/README.md`。快速入口：

- 设备枚举与打开：`libibverbs/device.c` → `ibv_get_device_list`（device.c:54）、`ibv_open_device`（device.c:363）。
- 对象创建入口：`libibverbs/verbs.c` → `ibv_reg_mr`（verbs.c:338）、`ibv_create_qp`（verbs.c:658）、`ibv_create_ah`（verbs.c:741）。
- 数据路径命令组装：`libibverbs/cmd.c` → `ibv_cmd_post_send`（cmd.c:603）、`ibv_cmd_post_recv`（cmd.c:691）、`ibv_cmd_poll_cq`（cmd.c:194）。
- 队列与完成：`providers/rxe/rxe.c` → `rxe_post_send`（rxe.c:1656）、`rxe_poll_cq`（rxe.c:555）。
- 连接管理：`librdmacm/cma.c` → `rdma_create_id`（cma.c:792）、`rdma_resolve_addr`（cma.c:1151）、`rdma_connect`（cma.c:1778）、`rdma_listen`（cma.c:1824）、`rdma_accept`（cma.c:1905）、`rdma_get_cm_event`（cma.c:2479）。

## 主实现 / 对照实现

| | 实现 | 角色 |
| --- | --- | --- |
| 主实现 | **rdma-core**（github.com/linux-rdma/rdma-core，tag `v49.0`） | verbs API、RDMA CM、RXE provider |
| 对照/补充 | **Linux 内核 verbs**（`uverbs` / `rdma_cm`，未复制） | ioctl 命令的接收端、QP 状态机内核侧实现 |
| 对照/补充 | Soft-RoCE（RXE）内核模块 | 数据路径与报文构造的实际执行者 |

对照目标是体会用户态与内核/硬件的职责边界：用户态只做对象句柄管理、WR 序列化与门铃（doorbell）下发，真正的状态机推进和报文收发在内核/硬件完成。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。上游版本固定为 rdma-core `v49.0`（commit `7e813ec60153061260ddfb216f4633b55ca4e99a`），源码复制自 tag 对应文件，未做任何改动（学习注释可加在副本上，另立补丁需在 `references.md` 说明）。