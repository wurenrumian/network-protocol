# 高性能网络与 I/O

## 定位

本模块位于协议学习主干之后，是「事件循环与 I/O」＋「用户态高速包处理」两块内容的起点。它不引入新的 wire 报文格式，而是研究**如何让多个连接、大量报文在资源有限的情况下更高效地被交付**：

- 阻塞 I/O 为何扛不住高并发（进程/线程与连接的比例、上下文切换）；
- 多路复用（select/poll → epoll/kqueue）如何把「等」从用户态进程下放到内核；
- Reactor/Proactor 两种事件模型如何组织处理逻辑；
- sendfile/splice 零拷贝如何减少用户态↔内核态之间的数据复制；
- io_uring 如何合并系统调用、用共享队列把「提交」与「完成」异步化；
- XDP/AF_XDP 与 DPDK 如何从内核栈旁路到用户态，把包处理推到 NIC/驱动边界。

主实现为 **nginx 事件循环** 与 **liburing**，分别对应传统多路复用路径和现代异步 I/O 路径；DPDK、AF_XDP 只做机制与取舍层面的对照，不复制驱动源码。

## 前置模块

按学习依赖关系，建议先完成（至少回看）以下模块：

1. **Ethernet / IP / UDP / TCP**（lwIP）：理解报文、连接、socket 数据路径，知道「一次读写到底在传输什么」。
2. **HTTP/1.1**（nginx）：nginx 事件循环的「业务侧」消费者，读 HTTP 模块时看到的 `rev->ready`、posted events、timeout 都来自本模块。
3. **TLS**（BoringSSL）：nginx 的事件循环与 SSL 握手/异步读写深度耦合，了解 TLS record 读写便于理解事件状态为何有「读一半、待重试」。

## 推荐阅读顺序

1. `protocol.md` — 先建立问题模型：阻塞/非阻塞/多路复用/异步的演进，Reactor 与 Proactor 的抽象差别，零拷贝各形态（sendfile/splice）的位置，io_uring/XDP/DPDK 在数据路径上的作用。
2. `state-machine.md` — 事件循环的状态流转与 io_uring 提交/完成队列生命周期。
3. `src/README.md` — 按调用链进入源码：先 nginx 事件循环闭环，再 liburing 提交/完成闭环。
4. 按 §4.7 顺序继续：XDP/AF_XDP → DPDK → RDMA。

## 源码入口

见 `src/README.md`。快速入口：

- 事件循环主循环：`upstream/nginx/src/event/ngx_event.c` 的 `ngx_process_events_and_timers()`
- epoll 实现：`upstream/nginx/src/event/modules/ngx_epoll_module.c` 的 `ngx_epoll_process_events()`
- 进程主循环：`upstream/nginx/src/os/unix/ngx_process_cycle.c` 的 `ngx_worker_process_cycle()`
- io_uring 提交/完成：`upstream/liburing/src/queue.c` 的 `io_uring_submit()`；完成 API `io_uring_get_cqe()` 为 `liburing.h` 头文件 inline
- io_uring 初始化：`upstream/liburing/src/setup.c` 的 `io_uring_queue_init()` / `io_uring_queue_exit()`

## 主实现 / 对照实现

| 用途 | 主实现 | 对照/补充 |
| --- | --- | --- |
| 事件循环与 I/O | **nginx**（事件循环、epoll）＋ **liburing**（io_uring） | Redis ae、epoll/kqueue 内核实现 |
| 用户态高速包处理 | **DPDK** | mTCP、Seastar、XDP/AF_XDP |

选型依据与详细表见根目录 `protocol-learning-design.md` §4.0、§4.7。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。`src/` 仅保留与闭环相关的完整上游文件，许可证见 `src/LICENSES/`。