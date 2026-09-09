# 高性能网络与 I/O · references

## 规范 / 标准

- Linux 系统调用手册（`man 2 epoll_*`、`man 2 sendfile`、`man 2 splice`、`man 2 io_uring_*`）：内核 I/O 原语的权威接口定义。
- io_uring ABI：`src/include/liburing/io_uring.h`（上游 liburing 仓库内的 UAPI 头），定义 sqe/cqe、opcode、`IORING_SETUP_*` 与 `IORING_OP_*` 常量。
- XDP：`man 8 xdp` / Documentation/networking/（内核 doc），以及 `Documentation/networking/af_xdp.rst`（AF_XDP 共享 UMEM/ring 语义）。
- DPDK 文档：https://doc.dpdk.org/ — 特别是 `Programmer's Guide` 中 Mbuf Library、Rings、Mempool Library、Poll Mode Driver（PMD）。
- NIC 驱动文档（对照）：Linux `ixgbe`/`i40e` AF_XDP 路径、e1000/ixgbe 的 XDP 支持。

## 论文

- Dan Kegel, *The C10K problem*（http://www.kegel.com/c10k.html）— 多路复用/非阻塞模型与高并发连接的开山综述，本模块「问题定义」的直接来源。
- Jens Axboe, *io_uring and networking in 2023*（lwn.net，2023）— io_uring 在网络场景的现状与限制。
- Jonathan Corbet, *Ringing in a new asynchronous I/O API*（lwn.net，2019）— io_uring 设计背景。
- *How to get 100Gbps networking from a server*（The Fastly blog / lwn.net）— DPDK/XDP 旁路性能对照。
- 可选的旁路对照：K. Yasukata et al., *mTCP: A Highly Scalable User-level TCP Stack for Multicore Systems*（NSDI 2014）— 用户态协议栈。

## 上游仓库（固定版本 / commit）

- **nginx**：https://github.com/nginx/nginx
  - 固定版本：tag `release-1.25.3`
  - 对应 commit：`b8fb83b8d2e7ca03d43176b767f1fc657f1c1ee2`
- **liburing**：https://github.com/axboe/liburing
  - 固定版本：tag `liburing-2.4`
  - 对应 commit：`298c083d75ecde5a8833366167b3b6abff0c8d39`

## 其他实现

- **Redis ae**（对照事件循环）：`src/ae.c`，aeMain/aeProcessEvents，用 `aeApiPoll` 抽象 epoll/kqueue，是比 nginx 更小的 Reactor 参考。
- **epoll/kqueue 内核实现**：Linux `fs/eventpoll.c`（红黑树 + 就绪链表）、FreeBSD `kqueue`；仅在需要解释多路复用内部机制时查阅。
- **Seastar**（对照异步/Proactor）：基于共享内存与 futures 的用户态网络栈，对比 nginx 的同步事件模型。
- **DPDK / mTCP / AF_XDP**：见 protocol.md「核心机制」，作为旁路路径对照，不复制驱动源码。

## 阅读备注

- nginx 的 epoll 实现全部在 `src/event/modules/ngx_epoll_module.c`；`src/event/ngx_event_epoll.c` 在 release-1.25.3 并不存在（`ngx_event_actions_t` 直接由 epoll 模块填充），因此本模块只复制 epoll 模块文件。
- liburing-2.4 的 `src/liburing.c` 不存在（该 tag 下 API 已按职责拆分到 `setup.c`/`queue.c`/`register.c`/`syscall.c`），故复制 `queue.c`、`setup.c`、`register.c` 以覆盖提交/完成/初始化/资源注册的闭环。
- 未复制的依赖（仅在 `src/README.md` 登记，不复制）：nginx 的 `ngx_connection.c`/`ngx_event_timer.c`/`ngx_cycle.c`、liburing 的 `include/liburing.h`/`syscall.c`/`register.c` 的依赖头文件、DPDK 源码。
- 学习注释规则：可在 `src/upstream/` 副本上直接加 `[STATE]`/`[INVARIANT]`/`[BOUNDARY]` 注释，不改变控制流与命名；确需修正时才另加补丁文件并在此说明。
- 本模块不要求编译运行（设计 §2 源码为主）；如需验证 io_uring 行为，可用 liburing 的 `examples/io_uring-test.c` 配合本地编译，但这不属于仓库交付内容。