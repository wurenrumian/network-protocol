# TCP · src

## 上游版本

- 仓库：`github.com/lwIP-tcpip/lwip`，tag `STABLE-2_1_3_RELEASE`（2.1.3），commit `6ca936f6b588cee702c638eee75c2436e6cf75de`（该 tag 指向此 commit，已核实）。
- 本目录直接复制上游文件，保留相对路径（`src/core/...`、`src/include/...`）；学习注释只能加在副本上。
- 许可证：`../LICENSES/COPYING`（lwIP BSD 许可证）。

## 文件清单（文件 → 类别 → 阅读范围）

| 文件（`src/upstream/` 下的路径） | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/include/lwip/prot/tcp.h` | core | **通读**：`tcp_hdr` 报文结构、`TCPH_*` 位操作宏、TCP 标志与选项常量。wire format 的权威定义。 |
| `src/include/lwip/priv/tcp_priv.h` | core | **通读**：`tcp_pcb` 控制块、状态枚举、`TCP_SEQ_*` 回绕比较、PCB 链表与 `TF_*` 标志；内部实现细节。 |
| `src/include/lwip/tcp.h` | core | 重点：`tcp_seg` 分段结构与 `tcp_pcb` 的公开定义、`tcp_*` 应用接口原型；跳过与泛用 API 重复的部分。 |
| `src/core/tcp_in.c` | core | 收包主路径：`tcp_input()` → `tcp_process()` → `tcp_receive()`，LISTEN/TIME-WAIT 分派、序列号检查、ACK 推进、乱序队列 `ooseq` 与选项解析。 |
| `src/core/tcp_out.c` | core | 发送路径：`tcp_output()` → `tcp_enqueue()` → `tcp_output_segment()`，ACK 构造、重传（RTO/快速）、Nagle、SACK/窗口扩大选项构造。 |
| `src/core/tcp.c` | core | 控制块生命周期与定时器：`tcp_tmr()` → `tcp_fasttmr()` / `tcp_slowtmr()`，`tcp_connect`/`tcp_listen`/`tcp_close`/`tcp_abort`、RTT 测量与重传上限、TIME-WAIT 回收。 |

**未复制、但属于同一闭环的依赖**（读源码时可跳转但不在本模块复制）：

- `src/include/lwip/ip4.h`、`ip6.h`、`ip_addr.h`：`ip_addr`/`ip4_addr`/`ip6_addr` 与地址转换。
- `src/include/lwip/pbuf.h`、`src/core/pbuf.c`：`pbuf` 内存管理，`tcp_seg` 的负载载体。
- `src/include/lwip/def.h`、`lwipopts.h`（示例配置 `lwipopts.h`）：`LWIP_U16`/`TCPWNDSIZE_F` 等类型与 `LWIP_*` 宏、`TCP_WND`/`TCP_MSS` 等可配置常量。
- `src/include/lwip/err.h`：`err_t` 错误码。
- `src/include/lwip/mem.h`、`memp.h`：内存池与 `pbuf` 分配器。
- `src/include/lwip/netif.h`、`src/core/netif.c`：`netif` 接口抽象（IP 层下行出口）。
- `src/core/ip4.c` / `ip6.c`：IP 层的封装/解封（`tcp_input` 的上游、`tcp_output` 的下游）。
- `src/core/tcpbase.h`（`tcp_priv.h` 引用）与 `tcpip.h`/`tcpip_priv.h`：泛用协议 API 与整合。

## 阅读顺序与调用链

按设计 §3 的例，围绕「收到 ACK 推进发送窗口」这一闭环组织（不按目录平铺）：

```
1. src/include/lwip/prot/tcp.h          报文结构：tcp_hdr、flags、选项常量
2. src/include/lwip/tcp.h + priv/tcp_priv.h   tcp_seg / tcp_pcb / 状态枚举 / 序列号比较
3. src/core/tcp_in.c                    收包：
   tcp_input()  [入口：IP 层 pbuf 进入]
     → 四元组查 PCB（含 TIME-WAIT / LISTEN 分派）
     → tcp_process()  序列号与 ACK 校验、FIN/RST/SYN 处理、状态推进
     → tcp_receive()  数据交付 rcv_nxt 推进、窗口通告
     → tcp_free_acked_segments()  释放 unacked 队列中已确认分段
4. src/core/tcp_out.c                   发送推进：
   tcp_output()  依据 snd_wnd/cwnd 从 unsent 取段
     → tcp_enqueue() / tcp_output_segment() 构造报文发往 IP
     重传：tcp_rexmit_rto() / tcp_rexmit_fast()
5. src/core/tcp.c                       定时与生命周期：
   tcp_tmr() → tcp_fasttmr() / tcp_slowtmr()
     → RTO 重传、cwnd 调整、FIN-WAIT-2 / TIME-WAIT 到期回收
     以及 tcp_connect/tcp_listen/tcp_close/tcp_abort
```

关键注释位置：`tcp_receive()` 的 ACK 推进（`[RFC:793]`）、`tcp_output()` 的窗口约束、`tcp_slowtmr()` 的重传上限与 TIME-WAIT 回收（`[INVARIANT]`/`[BOUNDARY]`）。

## 入口函数 / 结束函数

| 环节 | 入口 | 结束 |
| --- | --- | --- |
| 收包（数据平面） | `tcp_input()`（`tcp_in.c`） | 应用回调交付（`tcp_recv` 回调）或 RST/丢弃 |
| 状态推进 | `tcp_process()` → `tcp_receive()` | 交付/ACK 排队/状态迁移 |
| 发送 | `tcp_output()`（`tcp_out.c`） | `tcp_output_segment()` 交 IP 层 |
| 定时 | `tcp_tmr()`（`tcp.c`） | `tcp_slowtmr()`/`tcp_fasttmr()` 内的回收或重传提交 |
| 生命周期 | `tcp_connect`/`tcp_listen`/`tcp_close`/`tcp_abort` | PCB 从链表移除并释放（`tcp_free`） |

## 未复制的依赖

见上方「未复制的依赖」清单：`pbuf`、`ip_addr`、`err`、`netif`、`lwipopts`/`def.h` 等属于平台/基础设施层（platform/integration），不在本模块复制；`tcpbase.h` 为 TCP 内部公共定义，若需精读选项常量可再补入。

## 已复制 / 跳过说明

- **已复制**（与设计 §4.4 的 TCP 闭环一一对应，保留 `src/` 相对路径）：
  - `src/core/tcp.c`、`src/core/tcp_in.c`、`src/core/tcp_out.c`；
  - `src/include/lwip/tcp.h`、`src/include/lwip/priv/tcp_priv.h`、`src/include/lwip/prot/tcp.h`；
  - `src/LICENSES/COPYING`（上游 BSD 许可证）。
- **跳过并注明原因**：任务说明中的 `src/core/tcp_tmr.c` 在上游 2.1.3 中**不存在**——2.0 起 TCP 定时器已并入 `src/core/tcp.c`（`tcp_tmr()`、`tcp_fasttmr()`、`tcp_slowtmr()` 均在该文件，可 `grep tcp_slowtmr src/core/tcp.c` 验证）。经 GitHub API 核对整棵树无 `tcp_tmr.c`/`tcp_timer.c`。**不伪造内容**，定时器职责由 `tcp.c` 覆盖。
- 学习注释规范：仅记录协议语义（对应机制/字段、读取或修改的状态、维护的不变量、边界分支存在的理由），不翻译 C 语法，不改控制流；修正明显错误时另加补丁文件并在 `references.md` 注明。