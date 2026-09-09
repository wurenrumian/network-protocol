# DHCP · protocol

## 问题定义

**要解决的问题**：主机（尤其是无盘、嵌入式、移动设备）接入一个网络时，管理员不可能为每台机器手工配置 IP。需要一种机制，让主机启动后**自动**从服务器获得：

- 一个当前链路上可用的 IPv4 地址及其子网掩码；
- 默认网关、DNS、NTP 等附加参数；
- 以上参数的**有效期（租约）**，以及到期前自动续租的流程。

**明确不负责**：DHCP 不做地址的转发与路由（IP 模块负责）；不做链路层地址解析（ARP 负责）；不保证地址的强一致性（租约语义是「尽力而为的软状态」，服务器超时即可回收）。

**从 BOOTP 到 DHCP 的演进**：DHCP 直接继承 BOOTP（RFC 951，1985）的固定报文格式（`op`/`htype`/`hlen`/`hops`/`xid`/`secs`/`flags`/四个 IP 地址/`chaddr`/`sname`/`file`/`options`）。BOOTP 提供「磁盘无盘引导 + 静态绑定」；DHCP 在不动报文结构的前提下，把 `options` 从「供应商扩展」升级为协议核心，引入：

- **租约**（option 51）：地址不再永久绑定，而是有时间上限；
- **动态分配**：不再依赖静态 MAC→IP 表；
- **状态机与重传**：在无连接 UDP 上实现客户端驱动的可靠性；
- **消息类型**（option 53）：DISCOVER/OFFER/REQUEST/ACK/NAK/DECLINE/RELEASE/INFORM。

**DHCPv6**（RFC 3315）不继承 BOOTP，而是全新设计：报文不再有固定头，只有 `msgtype` + `transaction-id` + option 流；端口从 UDP 67/68 改为 546/547；地址协商从「服务器分配」扩展出「客户端生成 + 服务器确认」的模型。

## 抽象对象

### 租约（lease）

服务器授予客户端「在 T0 秒内使用地址 X」的权利，并附带两个时间点：

- **T1（renew）**：通常为 50% T0，此时客户端应**单播**向分配的服务器续租；
- **T2（rebind）**：通常为 87.5% T0，此时客户端若还没续租成功，改为**广播**请求任意服务器续租。

lwIP 中 `struct dhcp`（`src/include/lwip/dhcp.h`）直接持有这套时间对象：

```c
u32_t offered_t0_lease;  /* 租期（秒） */
u32_t offered_t1_renew;  /* 建议续租时间，通常 50% */
u32_t offered_t2_rebind; /* 建议重绑时间，通常 87.5% */
```

服务器未给 T1/T2 时，lwIP 在 `dhcp_handle_ack` 按安全公式推算：`T1 = lease/2`，`T2 = lease*7/8`。

### option（TLV）

option 是 DHCP 的扩展点。格式为 `code(1) + len(1) + value(len)`，以 code 0（PAD）填充、code 255（END）结束；长度受限时可用 option 52（overload）把 `sname`/`file` 字段也塞入 option。lwIP 把「收到的选项」解析进两个静态索引数组（`dhcp_rx_options_given[]` / `dhcp_rx_options_val[]`），对每个选项只保存「是否出现」和「值」两个判定量，配合宏 `dhcp_option_given`/`dhcp_get_option_value` 读取。

关键选项：

| code | 名称 | 用途 |
| --- | --- | --- |
| 1 | Subnet Mask | 子网掩码 |
| 3 | Router | 默认网关 |
| 6 | DNS Server | DNS 服务器列表 |
| 12 | Host Name | 客户端主机名 |
| 50 | Requested IP | 客户端请求的地址 |
| 51 | IP Address Lease Time | 租期（秒） |
| 53 | DHCP Message Type | 消息类型，**每报必带** |
| 54 | Server Identifier | 选定服务器的地址 |
| 55 | Parameter Request List | 客户端请求的选项清单 |
| 57 | Maximum DHCP Message Size | 客户端可接收的最大报文 |
| 58 / 59 | T1 / T2 | 续租 / 重绑时间 |

### 事务（transaction）

`xid`（32 位）把客户端的一次配置尝试与服务器应答绑定：同一状态下的重传复用同一个 `xid`，换新阶段（如 SELECTING → REQUESTING）则换新 `xid`，防止新旧应答串扰。

### 客户端状态（struct dhcp）

lwIP 把每接口的客户端状态挂在 netif 的 client-data 槽上（`netif_dhcp_data(netif)`），字段包含：`state`、`tries`（重试计数）、`request_timeout`、`t1/t2/t0_timeout`、`lease_used`、`offered_*` 系列、`server_ip_addr`、`xid`、`pcb_allocated`。

## wire format

### DHCPv4（继承 BOOTP，UDP 67/68）

固定 236 字节头 + 4 字节 magic cookie + options：

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  op (1) | htype(1)| hlen(1)| hops(1)|
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          xid (4)                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  secs (2) | flags (2) |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        ciaddr  (4)                            |
|                        yiaddr  (4)                            |
|                        siaddr  (4)                            |
|                        giaddr  (4)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     chaddr (16)                               |
|                     sname  (64)                               |
|                     file   (128)                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|              magic cookie 0x63825363 (4)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      options  (TLV, 可变)                      |
```

- `op`：1=BOOTREQUEST，2=BOOTREPLY；
- `xid`：客户端生成，应答必须回填；
- `ciaddr`：客户端**已有**的地址（RENEW/REBIND/RELEASE 时填写）；
- `yiaddr`：服务器**分配**的地址（OFFER/ACK 填写）；DHCPv4 永远不填写 `yiaddr` 之外的「你的地址」；
- `siaddr`：下一阶段引导服务器（PXE 场景）；
- `giaddr`：中继代理地址（跨网段时由 relay 填写，转发给服务器）；
- `chaddr`：客户端硬件地址，服务器用它标识客户端（`htype`/`hlen` 定义格式与长度）；
- magic cookie `0x63825363`：区分 DHCP 与老式 BOOTP 供应商扩展。

lwIP 以打包结构体 `struct dhcp_msg`（`src/include/lwip/prot/dhcp.h`）表达该报文，`PACK_STRUCT_*` 宏保证无填充字节；`options` 数组固定 `DHCP_OPTIONS_LEN`（默认 68 字节起）。

### DHCPv6（RFC 3315，UDP 546/547）

无固定头，只有 `msgtype(1)` + `transaction-id(3)` + option 流；option 是 `code(2) + len(2) + value`（大端），没有 PAD/END 概念。

- 客户端用 **DUID**（而非 MAC）标识自己；
- 地址由 **IA_NA/IA_ADDR** 选项表达，绑定到 DUID；
- 端口 546/547，多播 `ff02::1:2`（所有 DHCP 服务器和中继）；
- 服务器在给客户端发地址前，先 **DAD（重复地址检测）**确认地址在链路上未被使用（与 IPv6 邻居发现集成）。

## 核心机制

### DORA 流程（四次交互）

| 步骤 | 报文 | 源 → 目的 | 客户端状态（lwIP） | 关键字段 |
| --- | --- | --- | --- | --- |
| 1 | DISCOVER | `0.0.0.0:68` → 广播:67 | INIT → **SELECTING** | xid、option 55、option 57 |
| 2 | OFFER | 服务器:67 → 广播:68 | SELECTING（暂态） | yiaddr、option 54、51、58、59 |
| 3 | REQUEST | `0.0.0.0:68` → 广播:67 | SELECTING → **REQUESTING** | option 50（选中的地址）、54（选中的服务器） |
| 4 | ACK | 服务器:67 → 广播:68 | REQUESTING → **BOUND** | yiaddr、option 51/1/3/6… |

要点：

- **广播而非单播**：客户端尚未获得 IP，且可能有多个服务器应答（OFFER 可不止一个），广播保证「链路内所有人可见」；
- **REQUEST 必须回带 option 54**：向所有服务器宣告「我选了谁」；未被选中的服务器自动回收自己的 OFFER；
- **状态检查（可选）**：`DHCP_DOES_ARP_CHECK` 开启时，收到 ACK 后客户端先进入 CHECKING，用 ARP 探测地址是否被占；被占则发 DECLINE 拒绝该地址；
- **服务器是权威**：OFFER 是「预分配」，ACK 才是正式授予；NAK 表示客户端选择无效（地址被占/过期）。

lwIP 的实现对应：`dhcp_discover`（构造并广播 DISCOVER，置 SELECTING）→ `dhcp_handle_offer`（校验 option 54，记录 `server_ip_addr`，转 `dhcp_select`）→ `dhcp_select`（构造 REQUEST，置 REQUESTING）→ `dhcp_recv` 收到 ACK 后 `dhcp_handle_ack` + `dhcp_bind`（把 `offered_*` 写入 netif，置 BOUND）。

### 租约续租（生命周期）

状态与定时器（`dhcp_fine_tmr` 500ms / `dhcp_coarse_tmr` 60s）：

- **BOUND**：租期 T0、T1、T2 倒计时并行推进（`lease_used` 累计）；
- **T1 到期**（`dhcp_t1_timeout`）：单播 REQUEST 到原服务器（`server_ip_addr`），带 `ciaddr`，进入 **RENEWING**；
- **RENEWING 失败且 T2 到期**（`dhcp_t2_timeout`）：广播 REQUEST（不再带 server-id 限制），进入 **REBINDING**；
- **T0（租期）到期**：本地释放地址、回到 INIT 重新 DISCOVER（`dhcp_coarse_tmr` 中的 t0 分支）。

### option 协商

客户端在 DISCOVER/REQUEST 中携带 **Parameter Request List（option 55）** 声明希望收到的选项；服务器按列表填充 ACK。lwIP 的请求清单在 `dhcp_discover_request_options[]`（`src/core/ipv4/dhcp.c:168`），包含子网掩码、路由器、DNS、NTP 等。收到的选项由 `dhcp_parse_reply` 解析进索引数组，`dhcp_handle_ack` 再按需落地（`offered_sn_mask`、`offered_gw_addr` 等）。

### 无状态 UDP 上的可靠性

客户端状态机 + 重传定时器共同构成可靠性（对照 TCP 的窗口/ACK）：

- 每次发送后启动 `request_timeout`；
- 超时未收到期望应答 → 按状态重试：SELECTING/BACKING_OFF 重发 DISCOVER；REQUESTING 重发 REQUEST（`tries <= 5`）；REBOOTING 重发 REQUEST 至 `REBOOT_TRIES` 次后降级为 DISCOVER；
- 重传间隔指数退避：`(tries < 6 ? 1 << tries : 60) * 1000` 毫秒（`dhcp_discover` 末尾）。

### DHCPv6 差异（简要）

- 报文：固定头 → `msgtype + transaction-id + option 流`；
- 地址模型：`IA_NA` 封装地址，绑定 DUID；**不沿用** BOOTP 的 `yiaddr`；
- 协商：`SOLICIT → ADVERTISE → REQUEST → REPLY`（SARR，取代 DORA），地址由**客户端建议**（`IAADDR`），服务器确认或拒绝（状态码）；
- 无状态/有状态切分：无状态只下发 DNS 等参数（INFORMATION-REQUEST），地址交给 SLAAC/ND；
- 端口、多播、DUID、DAD 见上文 wire format 与机制。

lwIP 的 `dhcp6.c` 只实现了**无状态**客户端：状态仅 `OFF / STATELESS_IDLE / REQUESTING_CONFIG` 三态；`dhcp6_enable_stateful` 直接返回 `ERR_VAL`（未实现），这是对照 RFC 3315 看实现裁剪的好例子。

## 设计取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 报文格式 | 继承 BOOTP 固定头 | 兼容既有无盘引导设备；不改端口/报文即可演进 |
| 可靠性 | 客户端状态机 + 应用层重传 | 服务器保持无状态；广播域内天然多对多 |
| 分配模型 | 服务器授权（OFFER/ACK） | 地址冲突风险转移到服务器（集中管理）；客户端配合 ARP 复查 |
| T1/T2 | 由服务器建议、客户端执行 | 服务器可按地址池压力调节回收节奏 |
| 广播还是单播 | RENEW 单播、REBIND 广播 | 单播减轻服务器负担；广播在服务器失联时仍可自救 |
| 地址冲突 | ARP 探测（可选） | 与 ARP 耦合换一致性；关闭该选项则更快、更省流量 |
| DHCPv6 | 全新报文 | 不再背 BOOTP 包袱；地址自组织能力（SLAAC/IA）与 IPv6 邻居发现对齐 |

## 不变量

1. **租期单调**：`T1 ≤ T2 ≤ T0`；若服务器给的 T1 ≥ T2，lwIP 在 `dhcp_bind` 把 `t1_timeout` 置 0（等效 T1 = T2）。推导出 T1 = T0/2、T2 = T0*7/8 时自动满足。
2. **任何时刻至多一个租约状态**：`BOUND / RENEWING / REBINDING` 互斥；`dhcp_supplied_address` 只在这三个状态返回真。
3. **xid 匹配才处理应答**：`dhcp_recv` 对 `xid` 不匹配、`chaddr` 不匹配、`op != BOOTREPLY`、报文过短的应答一律丢弃，不改变任何状态。
4. **旧租约必须显式归还**：`dhcp_release`（RELEASE 报文 + OFF 状态）与 `dhcp_release_and_stop`（清零所有 `offered_*` 与定时器）保证不残留上一个租约的字段。
5. **地址写回 netif 的唯一入口**：`dhcp_bind` 是 BOUND 前唯一把 `offered_*` 应用到 `netif->ip_addr` 的路径；续租成功也只通过 `dhcp_bind` 重写。
6. **PCB 引用计数守恒**：共享 UDP PCB 的分配/释放成对出现（`dhcp_inc_pcb_refcount`/`dhcp_dec_pcb_refcount`）。

## 边界条件与异常处理

| 边界/异常 | 处理（lwIP 行为） | 对应代码 |
| --- | --- | --- |
| 服务器无响应 | 指数退避重传；REQUESTING 重试 5 次后放弃并重新 INIT | `dhcp_timeout` |
| REBOOTING 无应答 | 重传 `REBOOT_TRIES`(2) 次后降级为全流程 DISCOVER | `dhcp_timeout` |
| ACK 地址冲突（ARP 探测） | 发 DECLINE，进入 BACKING_OFF，10s 后重新 DISCOVER | `dhcp_check` / `dhcp_decline` |
| NAK | 回到 INIT 重新 DISCOVER（`dhcp_handle_nak`） | `dhcp_handle_nak` |
| 租期/定时器下溢 | 定时器值最小钳到 1 tick，避免立即到期风暴 | `dhcp_bind` 的 `if (timeout == 0) timeout = 1` |
| 单字节 MTU 的接口 | `dhcp_start` 直接拒绝（MTU 不足最小报文 576） | `dhcp_start` 的 MTU 检查 |
| option 截断/长度溢出 | `dhcp_parse_reply` 逐 option 校验长度，越界即 `ERR_BUF` 丢弃 | `dhcp_parse_reply` |
| 应答过快/重复 | 靠 `xid` + `chaddr` + 当前状态三重过滤，非法应答无副作用 | `dhcp_recv` |
| 服务器没收到的 RELEASE | 租约自然到期回收（软状态设计，无强一致要求） | 协议语义 |
| 无租期（`0xffffffff`） | 视为无限租期，`t0_timeout` 不设置（不启动到期路径） | `dhcp_bind` 中 `!= 0xffffffffUL` 分支 |