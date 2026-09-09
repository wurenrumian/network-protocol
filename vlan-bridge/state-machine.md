# VLAN / bridge / STP / LACP / LLDP · state-machine

## 状态

### STP（IEEE 802.1D，OVS `enum stp_state`）

| 状态 | 含义 | 学习 | 转发 |
| --- | --- | --- | --- |
| `STP_DISABLED` | STP 未启用，端口不受 STP 约束 | 否（不受控） | 否（不受控） |
| `STP_BLOCKING` | 端口在生成树之外；不学习、不转发用户数据，但收发 BPDU | 否 | 否 |
| `STP_LISTENING` | 过渡状态：等待 BPDU 信息、计时器推进 | 否 | 否 |
| `STP_LEARNING` | 端口即将转发，先学习 MAC 以降低泛洪冷启动损失 | 是 | 否 |
| `STP_FORWARDING` | 端口是生成树的一部分，正常转发 | 是 | 是 |

OVS 逐端口保存 `ofport_dpif.stp_state`，其值由外部 STP 引擎（`stp_port_get_state`）
推导，`update_stp_port_state()`（`ofproto-dpif.c:2816`）负责把引擎状态同步到
`ofport` 并触发副作用（学习表冲刷、bundle 更新、OpenFlow 端口状态位）。

### 相关：端口「可启用」与 bundle 泛洪

- 端口除 STP 状态外还有 `may_enable`（链路可用 + 非 No-Flood 等），二者共同决定实际转发。
- `bundle->floodable`：仅当 bundle 内所有端口都 Forwarding（STP）且无 No-Flood/legacy-L3
  时才为真（`bundle_update`，`ofproto-dpif.c:3173`）。

## 事件

STP 周期驱动由 `stp_run()`（`ofproto-dpif.c:2975`）发起：

1. **tick**：`stp_tick()` 推进状态机计时器（依据 `stp_last_tick` 的 elapsed，钳制到
   `INT_MAX` ms，防止事件循环长暂停后时间跳跃）。
2. **链路状态变化**：`stp_check_and_update_link_state()`，端口 up/down 触发 BPDU 处理。
3. **changed-port 队列**：`stp_get_changed_port()` 逐项取出状态变化的端口，
   调用 `update_stp_port_state(ofport)` 做同步。
4. **FDB 冲刷请求**：`stp_check_and_reset_fdb_flush()` 若为真，则冲刷 MAC 学习表与
   组播侦听表（STP 收敛路径改变，旧路径的 `(MAC, VLAN) → 端口` 条目不再可信）。

外部配置事件（`set_stp` / `set_stp_port`）直接启用/禁用 STP 并重新同步状态。

## 状态转移

STP 转移由 802.1D 的 BPDU 交换与计时器决定，主路径：

```text
STP_DISABLED ──启用──► STP_BLOCKING ──BPDU 发现根/收敛──► STP_LISTENING
    ▲                                                         │
    │                        timer/信息不足                    │
    └──────────────────────────────────────────────────────────┘
STP_LISTENING ──计时器(固定周期)──► STP_LEARNING ──计时器──► STP_FORWARDING
STP_LEARNING / STP_FORWARDING ──BPDU 变更/链路变化──► STP_BLOCKING（回退）
```

- **进入学习/转发的条件**：端口所属拓扑边被 STP 判定为树边；期间计时器逐级推进，
  保证网桥间传播延迟被容忍（Learning 期让下游学习上游 MAC）。
- **回退条件**：收到更高优先级路径信息、链路 down、或拓扑收敛要求移除该边。
- 实际转移的发起者是未复制的 `stp.*` 状态机；OVS 侧在 `update_stp_port_state` 中
  **只消费结果**：`stp_learn_in_state` / `stp_forward_in_state` 判定新旧状态，
  并做两件事：
  - 学习能力变化 → `mac_learning_flush()` + `mcast_snooping_mdb_flush()`；
  - 转发能力变化 → `bundle_update(bundle)` 重算 floodable，并设
    `need_revalidate = REV_STP` 请求流表重验证。

### 与 bundle/LACP 的耦合转移

`bundle_add_port` / `bundle_update` 中，STP 状态作为「该端口是否可用于泛洪」的判据之一：
非 Forwarding 端口使整个 bundle 不可泛洪。这保证聚合链路不会经由 STP 阻断的端口泄漏流量。

## 正常 / 异常时序

**正常收敛时序**：

```text
桥拓扑含环
  → STP 启用，所有端口 BLOCKING
  → BPDU 交换，选出根桥（最高优先权）
  → 树边端口依次 LISTENING → LEARNING → FORWARDING
  → 非树边端口保持 BLOCKING
  → 活动链路成树，环路消除
```

**异常/变化时序**：

```text
树端口链路 down
  → stp_check_and_update_link_state 感知
  → BPDU 触发重收敛
  → 端口回 BLOCKING（或经 LISTENING 重新入树）
  → FDB 冲刷请求 → mac_learning_flush
  → 学习表冷启动，短期泛洪，直至新路径学回
```

**长暂停防护**：`elapsed > 0` 且钳制到 `INT_MAX`，防止 sleep/挂起后计时器跳变
导致 BPDU 误判。

## 处理流程（无显式状态机时）

### bridge 的 MAC 学习流程（无状态机，流程式）

```text
端口收帧 (srcMAC, VLAN) 
  → mac_learning 表 lookup (srcMAC, VLAN)
  → 命中且为同 bundle → 刷新 idle（不迁移）
  → 命中且不同 bundle → 迁移/覆盖条目（学习一致性不变量）
  → 未命中 → 插入新条目，绑定入 bundle
  → 老化定时器到期 → 按 LRU 驱逐
```

触发点（`ofproto-dpif.c`）：

- **周期**：`run()` 中 `mac_learning_run()`（到期老化）；`mac_learning_wait()` 安排下次唤醒。
- **事件**：STP/RSTP 状态变化、bundle 变化、`set_flood_vlans`、接口 down
  → `mac_learning_flush()` 整体冲刷。
- **手动**：unixctl 命令 `fdb/add` / `fdb/delete`（`ofproto_unixctl_fdb_*`）维护静态条目。
- **数据路径**：`packet_xlate` 中 `XC_LEARN` 缓存条目在出包时批量提交
  （`ofproto_dpif_xcache_execute`），学习动作不阻塞转发主路径。

### LACP 成员状态（内部有状态机，OVS 侧仅消费结果）

- 周期入口 `bundle_run()`（`ofproto-dpif.c:3613`）→ `lacp_run(bundle->lacp, send_pdu_cb)`。
- 事件入口 `lacp_member_carrier_changed()` / `lacp_member_register()`（`bundle_add_port`）。
- 状态含义：成员 `current` / `expired` / `defaulted`；`port_is_lacp_current` /
  `port_get_lacp_stats` 向上暴露。
- 出口：`bond_run(bundle->bond, lacp_status(bundle->lacp))` 依据 LACP 判定决定成员
  may_enable，进而影响学习条目与负载均衡。

### LLDP（无转发状态机）

`set_lldp`（`ofproto-dpif.c:2491`）创建/配置/销毁端口 LLDP 实例；
`get_lldp_status` 上报邻居。无状态转移，属配置/报告流程。