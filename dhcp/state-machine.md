# DHCP · state-machine

本文档描述 DHCPv4 客户端显式状态机与 DHCPv6 简要流程。状态以 lwIP 2.1.3 `dhcp.c` 为准（`DHCP_STATE_*` 枚举定义于 `src/include/lwip/prot/dhcp.h`）。

## DHCPv4 客户端

### 状态

| 状态 | 含义 | lwIP 枚举 |
| --- | --- | --- |
| OFF | 未运行 / 已释放 | `DHCP_STATE_OFF` |
| INIT | 客户端初始化，准备发出 DISCOVER | `DHCP_STATE_INIT` |
| SELECTING | 已发 DISCOVER，等待 OFFER | `DHCP_STATE_SELECTING` |
| REQUESTING | 已发 REQUEST，等待 ACK | `DHCP_STATE_REQUESTING` |
| BOUND | 租约有效，地址写入 netif | `DHCP_STATE_BOUND` |
| RENEWING | 单播续租中（T1 后） | `DHCP_STATE_RENEWING` |
| REBINDING | 广播重绑中（T2 后） | `DHCP_STATE_REBINDING` |
| INIT-REBOOT | 重启后尝试凭记忆复用旧租约 | `DHCP_STATE_REBOOTING` |
| CHECKING | ARP 冲突探测中（`DHCP_DOES_ARP_CHECK`） | `DHCP_STATE_CHECKING` |
| INFORMING | 静态配置下仅获取参数 | `DHCP_STATE_INFORMING` |
| BACKING_OFF | 地址冲突被拒，退避后重新发现 | `DHCP_STATE_BACKING_OFF` |

### 事件

| 事件 | 触发源 |
| --- | --- |
| `dhcp_start(netif)` | 应用启动客户端 |
| OFFER 到达（`dhcp_recv` → `dhcp_handle_offer`） | 服务器应答 |
| ACK 到达（`dhcp_recv` → `dhcp_handle_ack`） | 服务器应答 |
| NAK 到达（`dhcp_recv` → `dhcp_handle_nak`） | 服务器拒绝 |
| `dhcp_fine_tmr` 超时 → `dhcp_timeout` | 500ms 定时器，请求重传 |
| `dhcp_coarse_tmr` → `dhcp_t1_timeout` / `dhcp_t2_timeout` / 租期到期 | 60s 定时器，租约生命周期 |
| `dhcp_renew(netif)` / `dhcp_release(netif)` / `dhcp_network_changed(netif)` | 应用 / 链路事件 |

### 状态转移

```text
                +--------------+  dhcp_start()
                |              v
                |           +-------+
                |           | INIT  |
                |           +---+---+
                |  OFFER 到期/重试  |    DISCOVER
                v           v       v
              +-------+  +------------+
              | SELECTING |  → REQUESTING (选中 OFFER 后 dhcp_select)
              +-------+    +------------+
                 |            ^    |
            OFFER  |     ACK/  |   NAK
            未选    |    超时重传|
                 |            |    v
                 |            |  INIT（重新开始）
                 v            |
          +------------+      |
          | REQUESTING |------+
          +------------+
              |
       ACK（且可选 ARP CHECKING 通过）
              v
          +-------+
          | BOUND |
          +---+---+
              | T1 到期
              v
          +----------+
          | RENEWING |
          +----------+
              | T2 到期（RENEW 未成功）
              v
          +-----------+
          | REBINDING |
          +-----------+
              | 租期 T0 到期 / 失败
              v
             INIT
```

补充分支：

- **INIT-REBOOT**：`dhcp_start` 时若 netif 已有记忆的地址，先进入 `REBOOTING`，广播 REQUEST（带 option 50 记忆地址）；`REBOOT_TRIES`(2) 次无响应则降级为 DISCOVER；收到 NAK 则清除记忆回到 INIT。
- **CHECKING**（`DHCP_DOES_ARP_CHECK` 且接口支持 ARP）：收到 ACK 后不直接 BOUND，先 ARP 探测 `yiaddr`；探测失败（被占用）发 DECLINE 进入 `BACKING_OFF`（10s 后重新 DISCOVER）；探测成功才 `dhcp_bind` → BOUND。
- **INFORMING**：`dhcp_inform` 使静态地址接口也能获取附加参数（单播 INFORM），结束后回 OFF。

### 超时与重试

| 状态 | 超时动作 | 重试上限 |
| --- | --- | --- |
| SELECTING | 重发 DISCOVER | `tries < 255`，间隔指数退避 `(1<<tries)` 秒（上限 60s） |
| REQUESTING | 重发 REQUEST | `tries <= 5`，超过则 `dhcp_release_and_stop` + 重新 `dhcp_start` |
| REBOOTING | 重发 REQUEST | `REBOOT_TRIES` = 2，超过则转 DISCOVER |
| CHECKING | 重发 ARP 探测 | `tries <= 1`，超过则视为无冲突直接 BIND |
| BACKING_OFF | 10s 后重新 DISCOVER | 无上限（配合 `tries` 退避） |
| BOUND/RENEWING/REBINDING | T1/T2/T0 倒计时驱动 | 由租期决定 |

### 正常 / 异常时序

**正常（首次上线）**

```text
dhcp_start
  → INIT: dhcp_discover（广播 DISCOVER，置 SELECTING）
  → dhcp_recv: OFFER（校验 xid/chaddr/op）
  → dhcp_handle_offer: 记录 server_ip_addr、offered_ip_addr，dhcp_select
  → SELECTING → REQUESTING: dhcp_select（广播 REQUEST，回带 option 50/54）
  → dhcp_recv: ACK
  → dhcp_handle_ack: 读取租期/T1/T2/掩码/网关
  → [CHECKING: ARP 探测] → dhcp_bind: 写入 netif，置 BOUND
```

**续租**

```text
BOUND --T1到期--> dhcp_t1_timeout → dhcp_renew（单播 REQUEST 带 ciaddr）→ RENEWING
RENEWING --T2到期且未成功--> dhcp_t2_timeout → dhcp_rebind（广播 REQUEST）→ REBINDING
任一阶段收到 ACK → dhcp_bind（重新写 netif，重置定时器）→ BOUND
REBINDING 也失败且租期到期 → dhcp_coarse_tmr t0 分支 → 释放并回到 INIT
```

**异常**

```text
SELECTING 收到无 option 54 的 OFFER → 丢弃（不改变状态）
REQUESTING 收到 NAK → dhcp_handle_nak → INIT → 重新 DISCOVER
CHECKING 探测冲突 → DECLINE → BACKING_OFF（10s）→ DISCOVER
RENEWING 收到单播无响应 → 继续到 T2 → REBINDING（广播自救）
```

### 闭环节点注释示例（对应 `dhcp_recv` 附近，lwIP 2.1.3 行号）

```c
/* [RFC:2131 §4.4] 收到 DHCPACK，且当前处于 REQUESTING：
 * [STATE] REQUESTING → BOUND（经 dhcp_bind）；
 * [INVARIANT] 旧租约字段在 dhcp_bind 中被整体覆盖，
 *             xid/chaddr/op 三层校验已保证应答归属本事务。 */
```

```c
/* [RFC:2131 §4.4.1] dhcp_timeout：SELECTING/BACKING_OFF 重发 DISCOVER，
 * [STATE] 保持当前状态（INVARIANT：重传不改变状态，仅更新 tries 与退避）；
 * [BOUNDARY] tries<6 时退避 1<<tries 秒，之后固定 60s，防广播风暴。 */
```

## DHCPv6 简要流程

lwIP 的 DHCPv6 只实现**无状态**客户端（`src/core/ipv6/dhcp6.c`），状态仅三态（`src/include/lwip/prot/dhcp6.h`）：

| 状态 | 含义 |
| --- | --- |
| `DHCP6_STATE_OFF` | 未启用 |
| `DHCP6_STATE_STATELESS_IDLE` | 无状态就绪，等待触发 |
| `DHCP6_STATE_REQUESTING_CONFIG` | 已发 INFORMATION-REQUEST，等待 REPLY |

**事件与转移**：

- `dhcp6_enable_stateless(netif)`：OFF → STATELESS_IDLE（绑定 UDP 546，注册 `dhcp6_recv`）；
- RA 触发 / 应用调用（`dhcp6_nd6_ra_trigger` 等）→ `dhcp6_information_request`：构造 INFORMATION-REQUEST（ORO 请求 DNS/NTP），置 REQUESTING_CONFIG，多播地址 `ff02::1:2`、端口 547；
- 收到 REPLY 且 xid 匹配 → `dhcp6_handle_config_reply`（把 DNS/NTP 写入相应引擎），状态回 STATELESS_IDLE；
- `dhcp6_tmr`（500ms）超时 → 重发 INFORMATION-REQUEST（指数退避，同 DHCPv4 策略）；
- `dhcp6_abort_config_request`：请求中收到触发信号 → 直接回 IDLE。

**关键差异（对照 DHCPv4）**：

- 状态从 11 个压缩到 3 个，因为无状态模式不持有租约；
- 有状态（SARR：SOLICIT/ADVERTISE/REQUEST/REPLY + IA_NA）在 lwIP 中 `dhcp6_enable_stateful` 直接返回 `ERR_VAL`，未实现——阅读时对照 RFC 3315 理解缺失部分（地址生成、DAD、租约维护）。

**闭环节点注释示例**：

```c
/* [RFC:3315 §18.1] dhcp6_recv：校验 transaction-id 与报文长度后
 * [STATE] REQUESTING_CONFIG → STATELESS_IDLE（仅 REPLY 触发）；
 * [INVARIANT] 无状态模式下不保留任何租约/地址状态，应答仅用于交付参数。 */
```