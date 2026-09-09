# 高性能网络与 I/O · src

## 上游版本

| 仓库 | 固定版本（tag） | commit |
| --- | --- | --- |
| nginx/nginx | `release-1.25.3` | `b8fb83b8d2e7ca03d43176b767f1fc657f1c1ee2` |
| axboe/liburing | `liburing-2.4` | `298c083d75ecde5a8833366167b3b6abff0c8d39` |

复制时保留原始相对路径；仅允许追加学习注释（`[STATE]`/`[INVARIANT]`/`[BOUNDARY]`），不改动控制流与命名。

## 文件清单（文件 → 类别 → 阅读范围）

### nginx

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `upstream/nginx/src/event/ngx_event.c` | **core** | 事件循环主体：`ngx_process_events_and_timers()`、epoll 等待超时与事件分发、posted 队列处理、`ngx_event_expire_timers()` 定时器触发 |
| `upstream/nginx/src/event/modules/ngx_epoll_module.c` | **platform** | epoll 具体实现：`ngx_epoll_create`、`ngx_epoll_add_event/del_event/enable`、`ngx_epoll_process_events`（epoll_wait 与就绪事件入队）、`ngx_epoll_init` |
| `upstream/nginx/src/os/unix/ngx_process_cycle.c` | **integration** | worker/master 进程生命周期：`ngx_worker_process_cycle()` 内多次调用 `ngx_process_events_and_timers()`，信号处理与退出路径 |

### liburing

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `upstream/liburing/src/queue.c` | **core** | io_uring 用户态队列抽象：`io_uring_get_sqe`、`io_uring_submit`/`io_uring_submit_and_wait`，内部完成变体 `__io_uring_get_cqe`/`__io_uring_peek_cqe`；公共完成 API `io_uring_get_cqe`/`io_uring_peek_cqe`/`io_uring_cqe_seen` 为 `include/liburing.h` 中的 inline（未复制），annotate 与 sqe 填写的辅助宏也在该头文件 |
| `upstream/liburing/src/setup.c` | **integration** | ring 生命周期：`io_uring_queue_init`/`io_uring_queue_init_params`（mmap SQ/CQ）、`io_uring_queue_exit`；`io_uring_setup`、`io_uring_enter` 经系统调用的封装 |
| `upstream/liburing/src/register.c` | **platform** | 资源注册：`io_uring_register_buffers`/`io_uring_register_files`（固定缓冲/文件），配套注销函数，与 `setup.c`/`queue.c` 构成完整闭环 |

注意：liburing-2.4 无 `src/liburing.c`（该文件名不存在于该 tag）；API 已拆分到以上文件。

## 阅读顺序与调用链

推荐链路（事件循环 → epoll 等待 → 连接/定时器 → io_uring 对照）：

1. `ngx_process_cycle.c`：`ngx_worker_process_cycle()`（进程生命周期壳）
2. → 每轮迭代进入 `ngx_event.c`：`ngx_process_events_and_timers()`（事件循环主体）
3. → 其中分发到 `ngx_epoll_module.c`：`ngx_epoll_process_events()`（epoll_wait → 逐事件入队并调用 handler）
4. → 回到 `ngx_event.c`：posted 队列处理 → `ngx_event_expire_timers()`（超时）
5. 对照异步路径（liburing）：
   - `setup.c`：`io_uring_queue_init()`（创建+mmap）
   - `queue.c`：`io_uring_get_sqe()` → `io_uring_submit()`（提交）；`io_uring_get_cqe()` → `io_uring_cqe_seen()`（完成，公共 API 为 `liburing.h` 头文件 inline）
   - `register.c`：`io_uring_register_buffers/files`（可选优化）

调用链归纳：

```
[nginx] master/worker 进程 → worker_process_cycle
  → process_events_and_timers（计算超时 → 等待 → 分发）
  → epoll_module::process_events（epoll_wait，就绪事件入 posted 队列 + handler）
  → 处理 posted 队列 → timer 超时（关闭空闲连接/回收）

[liburing] queue_init → get_sqe(填 sqe) → submit → (内核执行) → get_cqe(读 res) → cqe_seen
```

## 入口函数 / 结束函数

- nginx 事件循环：入口 `ngx_process_events_and_timers()`（`ngx_event.c`）；每次迭代结束后由 `ngx_worker_process_cycle()` 决定是否继续；进程退出结束时 `ngx_close_listening_sockets`/worker 清理。
- nginx epoll 路径：入口 `ngx_epoll_process_events()`；就绪事件逐一的 handler 终点随连接类型而异（读/写回调，见 `ngx_connection` 相关未复制模块）；epoll fd 在 `ngx_epoll_module` 初始化时创建（`ngx_epoll_create`），master 崩溃时由 `ngx_close_listening_sockets` 关闭。
- liburing：入口 `io_uring_queue_init()`（`setup.c`）；结束 `io_uring_queue_exit()`；提交通道 `io_uring_submit()`（`queue.c`），完成通道 `io_uring_get_cqe()`，归还 `io_uring_cqe_seen()`（后两者为 `liburing.h` 头文件 inline）。

## 未复制的依赖（仅登记）

- nginx：
  - `src/core/ngx_connection.c` / `src/core/ngx_cycle.c`（`ngx_connection_t`、连接池、cycle 管理；epoll 模块据此维护 fd→connection）
  - `src/event/ngx_event_timer.c`（`ngx_rbtree` 定时器；事件循环定时器已在本模块被 `ngx_event.c` 引用，但红黑树实现未复制）
  - `src/event/ngx_event_accept.c`（accept 事件：`ngx_accept`/`ngx_event_accept` 逻辑）
  - `src/event/ngx_event_posted.c`（posted 队列的实现被折叠进 `ngx_event.c`，未单独复制）
  - `src/core/ngx_inet.h`/`src/core/ngx_connection.h` 等头文件。
  - `config`/`auto/`（构建系统）、`docs/text/`（当前仅 LICENSE 复制）。
- liburing：
  - `src/include/liburing.h` 与 `src/include/liburing/io_uring.h`（公开 API/ABI 头，`queue.c` 直接依赖）
  - 注：公共完成 API `io_uring_get_cqe`/`io_uring_peek_cqe`/`io_uring_cqe_seen` 为 `liburing.h` 中的 inline 函数，需配合未复制的头文件阅读；`queue.c` 仅含内部变体 `__io_uring_get_cqe`/`__io_uring_peek_cqe`。
  - `src/syscall.c`/`src/syscall.h`（系统调用封装）
  - `src/lib.h`、`src/int_flags.h`（内部辅助）
  - `examples/`（io_uring-test 等示例）
  - 未复制底层 `include/uapi/linux/io_uring.h` 依赖（在 `src/include/` 的 upstream 副本中为 `io_uring.h`）。

## 已复制 / 跳过说明

- 已复制：上述 nginx 3 个文件 + liburing 3 个文件 + 两份 LICENSE。
- 跳过：
  - nginx `src/event/ngx_event_epoll.c`：**不存在**（本模块确认 404），epoll 实现全部在 `modules/ngx_epoll_module.c`。
  - liburing `src/liburing.c`：该 tag 不存在（404 确认）。
  - kqueue 实现（nginx `modules/ngx_kqueue_module.c`)：与 epoll 对称，仅作对照不复制。
  - `ngx_epoll_module` 之外的事件处理器（`ngx_event_pipe.c`/`ngx_event_udp.c`）：不属于本闭环。
  - DPDK、AF_XDP 源码：本模块只描述机制，不复制驱动（见 design §4.7）。
- 许可证：`LICENSES/nginx/LICENSE`（文档中版权声明）对应 nginx 源码，`LICENSES/liburing/LICENSE` 为 MIT 许可；两者与上游 tag 一一对应。