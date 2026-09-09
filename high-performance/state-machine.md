# 高性能网络与 I/O · state-machine

本模块没有一个类似 TCP 连接那种显式协议状态机，它的「状态机」体现在两条生命线：nginx 事件循环的每轮迭代，以及 io_uring 一个请求在提交/完成队列中的生命周期。两条都给出正常/异常时序。

## nginx 事件循环：一轮迭代的状态流转

主循环 `ngx_event.c::ngx_process_events_and_timers()`，每轮迭代经过以下状态：

```
S0 计算超时上限      最近 timer 到期时间 → epoll_wait 的 timeout（无 timer 则 -1）
S1 等待并分发就绪     ngx_epoll_process_events：epoll_wait → 对每个就绪事件
S2 标记并入队       设置 rev->ready=1，按事件类型挂入 posted 队列（可延迟的进 posted）
S3 accept 队列       处理 ngx_posted_accept_events（新增连接优先）
S4 读/写队列         处理 ngx_posted_events（逐个调用 handler）
S5 定时器到期        ngx_event_expire_timers：取红黑树最左节点，到期则删除并触发 timeout 处理
S6 回到 S0           新一轮迭代
```

转移条件（正常）：

- S1→S2：epoll_wait 返回就绪 fd 数组；无事件时等待由 timeout 上限决定（timer 或无限等待）。
- S2→S3→S4：accept 事件先处理（尽快建立新连接），其余读/写事件随后；顺序保证 accept 不被饥饿。
- S4→S5：事件 handler 可能注册/删除定时器，因此定时器检查放在 posted 处理之后。

异常分支：

- **EINTR**：epoll_wait 被信号打断（如 master 发重载/退出信号），S1 直接返回空就绪集，回到 S0 重新计算；进程生命周期检查在 `ngx_worker_process_cycle()` 外层。
- **handler 中事件处理失败**（连接读错误/EPOLLERR/EPOLLHUP）：handler 走关闭路径 `ngx_close_connection`，把事件从 epoll 删除，后续不再投递。
- **S2 队列满/入队冲突**：nginx 用 `ngx_posted_events` 链表，事件入队前检查 `event->posted`，避免同一事件重复入队（`ngx_post_event` 的防重入）。
- **定时器空转**：若无任何事件且 timer 为空，epoll_wait 用 -1（永久阻塞）；有事件但一直不来时靠 timer 上限保证超时处理仍能执行。

## nginx worker 进程状态（事件循环被嵌入进程生命周期）

`ngx_process_cycle.c::ngx_worker_process_cycle()`：

```
running → 循环 { ngx_process_events_and_timers(); 检查信号 } 
        → 收到 SIGQUIT/终止 → 关闭事件、释放 cycle → exited
```

信号（重载 SIGUSR1、优雅退出 SIGQUIT、快速退出 SIGTERM）由 master 发送，worker 在事件循环的每一轮 `ngx_worker_process_init` 之后的信号处理中响应；优雅退出等当前迭代处理完。异常：master 异常（SIGKILL）时 worker 检测到父进程死亡而自行退出。

## io_uring：一个请求的生命周期

sqe（提交）→ 内核执行 → cqe（完成）。状态包括：

```
S0 申请 sqe      io_uring_get_sqe(ring)：从 SQ 取一个空槽；队列满返回 NULL
S1 填写 sqe      opcode/fd/buf/offset/iodepth；填写后可提交
S2 提交          io_uring_submit()：经 io_uring_enter 批量提交 SQ 中待提交的 sqe；
                SQPOLL 模式下由内核线程轮询 SQ，无需每次 enter
S3 内核执行      请求在后台执行（可能异步完成）；应用此期间可继续做其他事
S4 取完成        io_uring_get_cqe() 阻塞等待，或 io_uring_peek_cqe() 非阻塞；
                cqe.res 为结果（负数 = -errno）
S5 归还 cqe      io_uring_cqe_seen()：标记完成事件已消费，CQ 槽位释放
```

转移条件与异常：

- S0→S1：`io_uring_get_sqe` 返回 NULL 表示 SQ 满，应用必须先 `io_uring_submit` 腾出空间。
- S2：提交数量超过 `ring` 的 `sq.head/sq.tail` 可容纳范围会失败；`io_uring_enter` 返回负 errno（EINTR 需重试，EAGAIN 需分批）。
- S4：`io_uring_get_cqe` 会阻塞直到有完成事件；配合 `IORING_ENTER_GETEVENTS` 可让一次 enter 同时等完成。
- S5 省略（`io_uring_cqe_seen` 未调用）→ CQ 队列耗尽 → S4 永远等不到新完成事件：**必须归还 cqe** 是本流程的不变量。
- 资源释放：`io_uring_queue_exit` 解除 mmap、归还注册的 buffers/files；必须先取消/等所有在途请求完成，再退出。
- 固定缓冲/固定文件模式：注册后的 buffers/files 在队列生命周期内保持有效，S1 填写的是 index 而非地址；注销后才能释放内存。

## 无显式状态机的部分（记录其处理流程）

- **sendfile/splice**：无状态机，是一次性系统调用序列：`open 源 → sendfile(dst, src, len) → 检查返回值=len（或 EAGAIN 下次重试）→ close`；EAGAIN 表示本次未搬完，事件循环把 dst 重新挂上写就绪再继续。
- **epoll 的 event 状态**：由 `EPOLL_CTL_ADD/MOD/DEL` 三个操作构成小型状态机：ADD 建立监听 → MOD 改兴趣集（可读→可写切换）→ DEL 移除（连接关闭时）；遗漏 DEL 会在连接复用后投递陈旧事件。
- **XDP/AF_XDP 与 DPDK**：核心是无环的生产-消费关系：NIC DMA 写入 RX ring（生产者）→ 用户态 PMD 轮询消费 → 处理完把缓冲放回 fill/复用队列 → NIC 再次填充。缓冲必须「借用→归还」，未归还前不可复用，是本流程唯一的硬约束。