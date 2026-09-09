# 高性能网络与 I/O · protocol

## 问题定义

高性能网络的核心问题：**在网络不改变报文内容的前提下，让进程在单位时间内处理更多连接、更高吞吐、更低延迟**。它不定义一个字节流协议，而是回答「报文/字节到达之后，用什么方式把它们高效地从内核交到用户态业务逻辑，再交回去」。

同一份数据要经过内核协议栈，才能抵达用户态应用，随之带来两类成本：

1. **等待成本**：一个进程在 read/write 上阻塞时，CPU 闲置，且每个连接需要独享一个线程/进程，连接数受线程数限制。
2. **复制与切换成本**：数据在网卡 DMA、内核缓冲、用户缓冲之间多次拷贝（读路径用户态一次，写路径一次），每次 read/write 都伴随一次系统调用与上下文切换。

目标可量化为：连接数（C10K→C10M 问题）、吞吐（每包处理开销）、延迟（事件交付到处理的时延）。围绕这些目标，出现了从阻塞、非阻塞、多路复用到异步 I/O 的演进，以及 sendfile/splice、io_uring、XDP/AF_XDP、DPDK 等降低每包成本的手段。本模块主实现（nginx 事件循环 + liburing）覆盖传统多路复用与 io_uring 两条主干，DPDK/AF_XDP 作为进一步旁路的对照。

明确不负责的：本模块不定义报文语义（属于 IP/TCP/HTTP），不负责数据正确性（校验、重传属传输层），也不做具体协议状态机。

## 抽象对象

- **fd（文件描述符）**：内核暴露给进程的 I/O 句柄；TCP 连接、UDP socket、事件通知（epoll fd）、文件都可统一为 fd，多路复用按 fd 监听可读/可写事件。
- **事件（event）**：内核/就绪集合报告「某 fd 可读/可写」或「定时器到期」。nginx 中为 `ngx_event_t`，带 `ready`、`active`、`posted`、`timeout` 等标志与一个 `handler` 回调。
- **事件循环（event loop）**：循环执行「等待事件 → 分发到 handler → 回到等待」。nginx 用 `ngx_process_events_and_timers()` 串起 epoll 等待、posted 队列、定时器三部分。
- **多路复用器**：内核侧等待若干 fd 就绪：select/poll（每次全量扫描）、epoll（事件驱动，只返回就绪者）、kqueue（BSD/macOS，功能更广，可监听文件事件）。nginx 的 `ngx_event_actions_t` 把底层接口抽象成 add/del/enable/disable/process 一组动作。
- **Reactor**：事件循环发现「I/O 就绪」后，把 fd 交给回调处理（应用在回调里做非阻塞读写）。nginx 默认是 Reactor 模式，由 epoll 驱动的读/写事件触发 `ngx_http_wait_request_handler` 等回调。
- **Proactor**：操作由内核/异步框架发起并完成，完成时再通知应用处理结果（内核把数据已放进用户缓冲才回调）。典型的 Proactor 需要异步 I/O 原语（如 io_uring）。
- **posted events（延迟事件）**：nginx 里不能立即执行（如持有锁、正在别处处理）的事件先入 posted 队列，当前迭代收尾时统一处理，避免重复调用与深层嵌套。
- **timer**：nginx 用红黑树（`ngx_event_timer.c`）组织超时事件，事件循环每次迭代根据最近的超时计算 epoll_wait 的等待上限，让「永远等不到事件」不会饿死定时器。
- **io_uring 队列**：`struct io_uring`（liburing 的用户态包装）持有共享内存中的 **SQ（submission queue）** 与 **CQ（completion queue）**，应用提交 `io_uring_sqe`（请求）到 SQ，内核处理完后把 `io_uring_cqe`（结果）放入 CQ。
- **XDP / AF_XDP**：XDP 是内核网卡驱动层面的 eBPF 处理点（收包最早可编程处），AF_XDP 是配套的 socket，通过共享的 UMEM/ring 直接把收/发包交给用户态，绕开内核协议栈。
- **DPDK mbuf**：DPDK 中报文的内存载体，头部与数据区一体、可回收复用，配合 ring、PMD（poll mode driver）与批处理（bulk RX/TX）实现内核旁路的用户态收发。

## wire format

本模块不定义新的报文格式，传统协议（以太帧/IP/TCP/HTTP）的字节流内容不变，本模块改变的是**这些数据在内核与用户态之间的移动方式**。因此把「wire format」理解为 I/O 数据路径上的格式与通道，核心是零拷贝机制：

- **sendfile**：`sendfile(out_fd, in_fd, ...)` 让内核直接在文件页缓存与 socket 缓冲之间搬运数据，不经用户态缓冲，省去一次用户态 read+write 的两次拷贝与系统调用；nginx `ngx_linux_sendfile`（`src/os/unix/ngx_linux_sendfile.c`）用于发送文件内容。
- **splice**：`splice(fd_in, off_in, fd_out, off_out, len, flags)` 在两个 fd（管道/文件/socket）之间移动数据，同样基于页缓存零拷贝，可在不落盘的管道与 socket 之间搬运。
- **io_uring 固定缓冲/固定文件（registered buffers/files）**：预先注册的缓冲与 fd，跳过每次 submit 的地址校验与文件引用计数，进一步降低每请求成本；DPDK 的 mbuf 池同理是预分配内存的复用。
- **XDP/AF_XDP 与 DPDK**：数据从网卡 DMA 直接进入用户态可访问的共享内存（UMEM / mbuf 池），由用户态驱动或 PMD 轮询，数据路径上不经过内核协议栈的逐层拷贝。

要点：多路复用只解决「等」的问题（一次等待多个 fd），不减少数据拷贝；零拷贝与旁路技术解决「搬」的问题（减少拷贝与系统调用）。两者正交，nginx 同时使用 epoll（等）与 sendfile（搬）。

## 核心机制

### 阻塞 / 非阻塞 / 多路复用 / 异步 的演进

1. **阻塞 I/O**：read/write 挂起当前线程直到完成，一连接一线程，线程数与连接数成正比；连接多时线程调度开销成为瓶颈。
2. **非阻塞 I/O**：read/write 立即返回（EAGAIN/EWOULDBLOCK），配合轮询（忙等）避免独占线程，但轮询浪费 CPU。
3. **多路复用**：select/poll/epoll/kqueue 一次等待一组 fd，内核只在有事件就绪时唤醒；epoll 用红黑树+就绪链表，就绪时直接拷贝就绪事件，避免每次全量遍历，适合大量长连接。
4. **异步 I/O**：应用提交请求后立刻继续，内核完成读写并交付结果后才通知（io_uring 的 CQ 完成队列）。io_uring 把「提交一批请求」和「取一批结果」都做成批量系统调用，突破单次 I/O 必须一次系统调用的限制。

### nginx 事件循环

主循环见 `src/event/ngx_event.c::ngx_process_events_and_timers()`：

```
计算最近定时器超时 → 确定 epoll_wait 超时上限
→ ngx_process_events(epoll 等待并分发就绪事件)
→ 处理 ngx_posted_accept_events（accept 延迟队列）
→ 处理 ngx_posted_events（读/写延迟队列）
→ 超时检查 ngx_event_expire_timers()
```

- **epoll 模块**（`src/event/modules/ngx_epoll_module.c`）：`ngx_epoll_add_event/ngx_epoll_del_event` 通过 `epoll_ctl` 维护 epoll 实例；`ngx_epoll_process_events` 一次 `epoll_wait` 拿到就绪数组，逐个把就绪事件挂到 posted 队列并调用 handler。
- **accept 事件与 load balancer**：`ngx_event_accept.c` 从监听 socket accept 新连接并分配 `ngx_connection_t`；多个 worker 竞争 accept 时通过 `ngx_trylock_accept_mutex` 保证同一时刻只有一个 worker 抢锁 accept，再用 reuseport 或 TCP_DEFER_ACCEPT 等减少惊群。
- **连接生命周期**：`ngx_cycle_t`、`ngx_connection_t`（含读/写两个 `ngx_event_t`）在 `src/core/ngx_connection.c`，本模块只通过事件接口观察其读写与空闲（keepalive）管理。
- **worker 进程主循环**：`src/os/unix/ngx_process_cycle.c::ngx_worker_process_cycle()` 不断调用 `ngx_process_events_and_timers()`，同时接收 master 的信号（重载、退出、重启），是「事件循环被嵌入进程生命周期」的入口。

### Reactor 与 Proactor

- **Reactor（nginx/Redis 的模型）**：事件循环观察到「fd 可读/可写」，调用应用回调；回调内必须自己完成非阻塞读写，若数据未就绪则重新注册事件等待。同步的、事件驱动的，调度权在事件循环。
- **Proactor**：应用发起异步读（如 io_uring `IORING_OP_READV`），内核把数据直接写入应用提供的缓冲后，才在完成队列放入 cqe；应用只处理「结果」，不处理「就绪等待」。异步的、结果驱动的，调度权部分移交给内核。
- **取舍**：Reactor 简单、与阻塞式业务代码兼容、适合请求处理量不大的场景；Proactor 能消除「就绪后仍可能再等待数据」的空转，但对缓冲生命周期管理、内存管理要求更高，与语言的异步运行时配合才明显受益。nginx 用 Reactor 并把耗时操作交给线程池，io_uring 生态则更接近 Proactor。

### sendfile / splice 零拷贝

- `sendfile` 由内核在页缓存与 socket 间拷贝，减少一次用户态往返；nginx 对静态文件启用 `sendfile on`，路径见 `ngx_http_copy_filter` 与 `ngx_linux_sendfile`。受限于「必须直接发文件、目标必须是 socket」，更适合发送文件内容。
- `splice` 通过管道搬运，可用于任意 fd 对（含网络→文件、管道→socket），是 sendfile 的推广；两者都依赖页缓存零拷贝，要求源页已缓存或能从磁盘直接映射，无法避免磁盘读。

### io_uring 提交 / 完成

1. `io_uring_queue_init(entries, ring, flags)`（`setup.c`）：创建 ring 并 mmap 共享内存（SQ/CQ），flags 可开启 `IORING_SETUP_IOPOLL`（I/O 轮询，配合专用驱动）等。
2. 应用填写 `io_uring_sqe`（opcode、fd、buf/offset、flags），`io_uring_submit()`（`queue.c`）把一批 sqe 经 `io_uring_enter` 批量提交；提交后可 `io_uring_get_cqe()` 阻塞或 `io_uring_peek_cqe()` 非阻塞取完成事件，`io_uring_cqe_seen()` 归还 cqe（后三者与 `queue.c` 的内部变体对应，公共 API 为 `liburing.h` 头文件 inline）。
3. 结果在 `io_uring_cqe` 的 `res` 中（负数表示 errno），一次 `io_uring_enter` 可提交多请求，配合 `IORING_SETUP_SQPOLL` 还可由内核线程轮询 SQ，连系统调用都省掉。
4. `io_uring_queue_exit()` 释放共享内存与注册资源。

### XDP / AF_XDP

- XDP 在网卡驱动收包最早点（`xdp_rxq_info`）挂 eBPF 程序，可 drop/pass/redirect，用于 DDoS 过滤、负载均衡等；处理仍在内核。
- AF_XDP 提供共享 UMEM 缓冲池 + RX/TX ring + fill/completion ring，用户态直接读写网络报文，绕过协议栈，保留内核收包与内存管理。需驱动支持（如 i40e/ixgbe 的 AF_XDP 路径）。
- 取舍：比 DPDK 安全、无需独占网卡与禁止内核驱动，但仍有内核参与；性能低于完全旁路的 DPDK。

### DPDK 内核旁路

- PMD（poll mode driver）通过 UIO/VDUSE 把网卡映射进用户态，应用**轮询**收包队列，没有中断与系统调用。
- 数据以 **mbuf** 池分配，mempool（ring 无锁队列）预先分配并回收；收发都是批处理（收 32/64 个再处理）。
- 特性：大页内存避免 TLB miss、NUMA 感知、CPU 隔离（isolcpus）、`--huge-dir` 与 `rte_eal_init` 初始化。代价：独占网卡、不经过内核协议栈（TCP/IP 要自己实现，如 mTCP）、轮询占用整核。

## 设计取舍

| 取舍点 | 选择 | 理由 / 代价 |
| --- | --- | --- |
| 多路复用 vs 一连接一线程 | epoll/kqueue | 连接数不再受线程数限制；代价是把每个 fd 的状态管理责任交给事件循环 |
| epoll vs select/poll | epoll | 就绪事件直接返回，O(就绪数) 而非 O(总 fd 数)；代价是依赖 Linux 特定 API |
| Reactor vs Proactor | nginx 用 Reactor | 兼容同步业务代码、调试简单；代价是就绪到读完之间可能再等 |
| 事件循环单线程 vs 多线程 | 每 worker 一个事件循环 | 无锁；代价是需自己管理 worker 间负载与惊群 |
| sendfile vs 用户态拷贝 | 静态文件用 sendfile | 少一次拷贝；代价是只适用直接发文件到 socket |
| io_uring vs epoll | liburing 作为对照路径 | 批量提交/完成、可选 SQPOLL 免系统调用；代价是内核版本要求、内存管理更复杂 |
| 内核栈 vs 旁路（XDP/DPDK） | 性能敏感处旁路 | 减少每包开销；代价是放弃内核协议栈能力、独占资源、实现成本高 |

核心权衡：**每次系统调用/每次拷贝都有成本，凡是能合并、能共享、能预分配的都值得做**；但优化对象不同（等待 vs 搬运），手段也不同，需按场景组合。

## 不变量

- **事件与连接生命周期一致**：nginx 中 event 绑定到 connection；连接关闭（`ngx_close_connection`）时对应事件必须从 epoll 删除并清 `active`，绝不允许已关闭连接的事件仍被投递。
- **就绪事件必须被消费**：读事件 handler 必须处理到 `rev->ready` 清除或重新注册为止；否则下一轮 epoll_wait 可能立即再次返回同一就绪事件，导致忙循环。
- **posted 队列先进先出、一次性处理**：事件入 posted 后，在事件循环同一迭代内被消费，处理时从队列头取出，防止同一事件被多次加入或嵌套重入。
- **timer 红黑树按到期时间有序**：事件循环取树中最左节点作为 epoll_wait 超时上限，保证没有事件时定时器也能按时触发；已到期事件在 `ngx_event_expire_timers` 中处理并从树中删除。
- **io_uring：sqe 一旦提交不可改**；cqe 必须用 `io_uring_cqe_seen()` 归还，否则 CQ 队列耗尽；同一 sqe 槽位在请求完成前不能被覆盖。
- **XDP/DPDK：同一缓冲不能同时被内核驱动与用户态写**，mbuf 归还到池后才是「空闲」状态；UMEM 的帧在未收到 cqe 前不能复用。

## 边界条件与异常处理

- **EAGAIN / EWOULDBLOCK**：非阻塞读写数据未就绪时的正常返回；事件循环必须等待下一次就绪事件，而非自旋。
- **EINTR**：epoll_wait 被信号打断；nginx 在 `ngx_epoll_process_events` 检查 `ngx_event_flags & NGX_USE_CLEAR_EVENT` 等标志并继续等待，worker 收到 master 信号时也能及时醒来。
- **EPOLLERR / EPOLLHUP**：对端异常断开或半关闭；`ngx_epoll_process_events` 把这些视为可读/可写处理，最终由连接 handler 关闭连接并清理事件。
- **超时连接**：keepalive 超时后由 timer 触发 handler 关闭空闲连接；连接被关闭时必须先删除对应事件，防止 epoll 再投递已失效 fd。
- **accept 竞争与惊群**：多个 worker 同时 accept 会惊群；nginx 用 accept mutex 与 reuseport 控制，失败则让出本轮 accept。
- **事件循环饿死**：若某事件 handler 阻塞过久，后续事件全部延迟；因此 nginx handler 内禁止阻塞 I/O，耗时操作转入线程池。
- **io_uring 资源耗尽**：cqe 未归还导致 CQ 满、`io_uring_get_cqe` 阻塞等待；`io_uring_submit` 返回负值表示 EINTR/EAGAIN，需要重试或分批。
- **ring 初始化失败**：`io_uring_queue_init` 返回负 errno（如 `ENOMEM`、内核不支持），应用需回退到 epoll/阻塞 I/O。
- **DPDK/XDP 边界**：页表/驱动不支持、NUMA 不匹配、内存池耗尽时，收发失败必须能被检测；PMD 是轮询，没有事件可等，忙等本身就是设计而非异常。