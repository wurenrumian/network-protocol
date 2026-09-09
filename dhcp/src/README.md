# DHCP · src

本目录是源码导航页，不复述协议内容。上游 lwIP 文件按 §3 规范复制到 `upstream/`，保留原始相对路径；对文件的改动仅限学习注释。

## 上游版本

- 上游：github: lwIP-tcpip/lwip
- 版本：`STABLE-2_1_3_RELEASE`
- commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：BSD-3-Clause（见 `LICENSES/`）

## 文件清单（文件 → 类别 → 阅读范围）

### core/（协议本身，主阅读范围）

| 上游路径 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/core/ipv4/dhcp.c` | core | 全部（1991 行）。DHCPv4 客户端状态机、报文构造/解析、T1/T2/T0 定时器、重传与异常分支。**跳过**：`LWIP_DHCP_BOOTP_FILE`、`LWIP_DHCP_GET_NTP_SRV`、`LWIP_DHCP_AUTOIP_COOP` 等可选编译块（读注释理解用途即可） |
| `src/include/lwip/dhcp.h` | core | 全部。`struct dhcp`（租约/定时器/状态字段）与公开 API（`dhcp_start`/`dhcp_renew`/`dhcp_release`/`dhcp_stop`/`dhcp_*_tmr`） |
| `src/include/lwip/prot/dhcp.h` | core | 全部。`struct dhcp_msg`（wire 格式）、`DHCP_STATE_*` 枚举、option 常量、magic cookie |
| `src/core/ipv6/dhcp6.c` | core | 全部（821 行）。DHCPv6 无状态客户端；`dhcp6_enable_stateful` 未实现（返回 `ERR_VAL`），注意对照 |
| `src/include/lwip/dhcp6.h` | core | 全部。`struct dhcp6`、`dhcp6_enable_*`/`dhcp6_tmr`/`dhcp6_nd6_ra_trigger` API |
| `src/include/lwip/prot/dhcp6.h` | core | 全部。`struct dhcp6_msg`、`DHCP6_STATE_*`、消息类型/状态码/DUID 常量、端口 546/547 |

### integration/（与 netif、ARP、DNS 的连接）

| 上游路径 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/core/netif.c` | integration | 仅 `netif_set_client_data`/`netif_get_client_data`（client-data 槽挂载 `struct dhcp`）；其余跳过 |
| `src/include/lwip/netif.h` | integration | 仅 `LWIP_NETIF_CLIENT_DATA_INDEX_DHCP/DHCP6` 与 client-data 宏 |
| `src/core/ipv4/etharp.c` | integration | 仅 `DHCP_DOES_ARP_CHECK` 路径：ARP 探测 `yiaddr`、冲突回调 `dhcp_arp_reply`；其余跳过 |
| `src/core/dns.c` / `src/include/lwip/dns.h` | integration | 仅 DNS 服务器交付：`dhcp_handle_ack` 中 `dns_setserver`；其余跳过 |

### platform/（支撑收发与定时）

| 上游路径 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/core/udp.c` | platform | 仅 `udp_bind`/`udp_recv`/`udp_sendto_if`/`udp_sendto_if_src`（DHCP 收发的下层调用）；其余跳过 |
| `src/include/lwip/udp.h` | platform | 仅上述函数签名与 PCB 结构引用 |
| `src/include/lwip/prot/iana.h` | platform | 仅端口常量 `LWIP_IANA_PORT_DHCP_SERVER(67)`/`DHCP_CLIENT(68)` |

> 未复制的依赖见「未复制的依赖」。核心阅读量为 `core/` 六个文件；`integration/` 与 `platform/` 仅按需跳读。

## 阅读顺序与调用链

建议按「入口 → 状态机 → 报文 → 下层发送 → 定时器」的闭环组织，而非按目录平铺：

```text
dhcp_start(netif)                       # 入口：分配 struct dhcp、绑定 UDP 67 监听、置 INIT
→ dhcp_discover(netif)                  # 构造 DISCOVER（dhcp_create_msg + option 组装），广播，置 SELECTING
→ [dhcp_recv] OFFER → dhcp_handle_offer  # 校验 xid/chaddr/op，记录 server_ip_addr，dhcp_select
→ dhcp_select(netif)                    # 构造 REQUEST（回带 option 50/54），置 REQUESTING
→ [dhcp_recv] ACK → dhcp_handle_ack     # 解析租期/T1/T2/掩码/网关
→ [ARP CHECKING] → dhcp_bind(netif)     # 写回 netif->ip_addr，置 BOUND，设置 t0/t1/t2 定时器
→ dhcp_fine_tmr / dhcp_coarse_tmr       # 500ms 重传驱动；60s 租约生命周期
→ dhcp_t1_timeout → dhcp_renew          # RENEWING（单播）
→ dhcp_t2_timeout → dhcp_rebind         # REBINDING（广播）
→ 租期到期 → dhcp_release_and_stop → dhcp_start   # 归还租约，回到 INIT
```

调用链中关键函数的归属文件：

| 函数 | 文件 | 闭环中的职责 |
| --- | --- | --- |
| `dhcp_start` | `src/core/ipv4/dhcp.c` | 入口；MTU 检查、分配 `struct dhcp`、绑定 PCB |
| `dhcp_create_msg` / `dhcp_option*` | 同左 | 报文构造：固定头 + magic cookie + option 组装 + trailer（END/PAD） |
| `dhcp_parse_reply` | 同左 | 报文解析：从 pbuf 展开 option 到索引数组 |
| `dhcp_recv` | 同左 | 收包：op/xid/chaddr/长度校验 → 按状态分发 OFFER/ACK/NAK |
| `dhcp_bind` | 同左 | 出口：把 `offered_*` 应用到 netif，初始化 t0/t1/t2 定时器 |
| `dhcp_handle_ack` | 同左 | 租约计算：T1/T2 缺省值推导（`lease/2`、`lease*7/8`） |
| `dhcp_coarse_tmr` / `dhcp_fine_tmr` | 同左 | 定时驱动：t0/t1/t2 到期与请求重传 |
| `dhcp_timeout` | 同左 | 重传分发：按状态决定重发 DISCOVER/REQUEST/REBOOT |
| `dhcp6_enable_stateless` / `dhcp6_information_request` / `dhcp6_recv` / `dhcp6_tmr` | `src/core/ipv6/dhcp6.c` | DHCPv6 无状态闭环 |

## 入口函数 / 结束函数

**DHCPv4**

- 入口：`dhcp_start(netif)`（`dhcp.c:742`）—— 应用调用后进入 INIT。
- 结束：`dhcp_stop(netif)`（停止并清零，不回 OFF 上报）/ `dhcp_release_and_stop(netif)`（发 RELEASE 后停）/ `dhcp_cleanup(netif)`（释放 `struct dhcp`，移除 client-data）。

**DHCPv6**

- 入口：`dhcp6_enable_stateless(netif)`（`dhcp6.c:299`）—— 绑定 UDP 546、注册 `dhcp6_recv`、置 STATELESS_IDLE。
- 结束：`dhcp6_disable(netif)` / `dhcp6_cleanup(netif)`。

**定时器（生命周期驱动，非入口/出口）**：`dhcp_fine_tmr`（500ms）/ `dhcp_coarse_tmr`（60s）/ `dhcp6_tmr`（500ms），由应用或 `LWIP_NUM_SYS_TIMEOUT_INTERNAL` 调度。

## 未复制的依赖

以下上游文件/符号在闭环中被引用，但**未复制**到 `upstream/`，阅读时对照同名函数签名即可：

| 依赖 | 说明 |
| --- | --- |
| `src/core/mem.c` / `mem.h` | `mem_malloc`/`mem_free` 内存分配（`struct dhcp` 生命周期） |
| `src/core/pbuf.c` | `pbuf_alloc`/`pbuf_realloc`/`pbuf_free`/`pbuf_get_contiguous` 报文缓冲 |
| `src/core/ipv4/ip4.c` 等 | `ip4_addr_copy`/`ip4_addr_set_u32`/`lwip_htonl` 等地址运算 |
| `src/core/def.c` 等 | `LWIP_DEBUGF`/`LWIP_ASSERT` 调试宏 |
| `src/include/lwip/opt.h` | `LWIP_DHCP*` 编译开关与 `LWIP_HOOK_DHCP*` 扩展点 |

许可证副本（BSD-3-Clause 及相关版权声明）置于 `LICENSES/`。