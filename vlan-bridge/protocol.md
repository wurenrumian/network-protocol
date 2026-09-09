# VLAN / bridge / STP / LACP / LLDP · protocol

## 问题定义

**隔离 / 广播域 / 环路**三个问题的精确定义：

1. **隔离（isolation）**：一台交换式网桥把所有端口连入同一个广播域。VLAN 在帧上附加
   「虚拟局域网 ID」，把广播域进一步切分：不同 VLAN 之间的帧不互相可见、不互相转发。
   隔离的本质是**寻址域与转发域的重新界定**：MAC 学习表以 `(MAC, VLAN)` 为键，转发
   以 `(MAC, VLAN, 端口)` 为约束。
2. **广播域（broadcast domain）**：网桥的泛洪（flood）范围。一个 bridge 对一个未知单播、
   广播或组播帧向「同 VLAN 内除入端口外的所有端口」泛洪。VLAN 把泛洪限制在子集内。
3. **环路（loop）**：物理拓扑含环时，透明桥的「无目标时泛洪」会导致帧无限复制循环，
   引发广播风暴。STP 在桥上运行为图，剔除冗余链路，把逻辑拓扑变成树。

**明确不负责什么**：本模块不解决跨网段路由（那是 IP 层）；不解决广域网编址；
VLAN 不在广域网传播（802.1Q 帧只在网桥/交换机域内合法）。LACP 只负责链路聚合与成员
可用性判断，不改变帧寻址语义。

## 抽象对象

主实现 Open vSwitch 的核心对象（对应源码位置见 `src/README.md`）：

| 抽象 | 含义 | 主要源码载体 |
| --- | --- | --- |
| **bridge（ofproto）** | 一台逻辑交换机；持有 MAC 学习表、STP/RSTP 状态、各 bundle | `ofproto-dpif.c` 中 `struct ofproto_dpif` 与 `run()` |
| **port（ofport / netdev）** | 一个物理或虚拟端口；含 VLAN 配置、STP 状态、LLDP 实例 | `ofproto-dpif.c` 的 `struct ofport_dpif`；`netdev.c` 的 `struct netdev` |
| **bundle（ofbundle）** | 一组端口（bond）：LACP 聚合或冗余组合；决定 flood 范围与学习端口 | `ofproto-dpif.c` 的 `struct ofbundle` |
| **flow** | 一次匹配/转发的关键字段集合（源 MAC、目的 MAC、VLAN、EtherType、端口等） | `flow.c` 的 `struct flow` 与 `parse_vlan()` |
| **datapath（dpif）** | 实际执行流表匹配与动作的「datapath 接口」；OVS 中由 ovs-vswitchd 进程外引擎或 dpdk 等实现 | `dpif.c` 的 `struct dpif` 与 `dpif_recv/send/flow_*` |
| **MAC learning table** | `(MAC, VLAN) → 端口` 的映射，含老化与静态条目 | `ofproto-dpif.c` 中 `mac_learning_*` 调用；未复制实现 |

## wire format

### 802.1Q VLAN 标签

在以太帧的源 MAC 与 EtherType 之间插入 4 字节 TCI：

```
 6B dst MAC | 6B src MAC | 2B TPID=0x8100 | 2B TCI | 2B EtherType | payload
```

- `TPID=0x8100`：标记 VLAN 标签的存在（`flow.c` 用 `eth_type_vlan()` 识别）。
- TCI 16 位：高 3 位 `PCP`（802.1p 优先级）、第 4 位 `DEI`/`CFI`、低 12 位 `VID`。
- VID=0 表示「无 VLAN」或优先级标签帧；VID=4095 保留（`flow.c` 用 `VLAN_VID_MASK`）。
- OVS 支持嵌套标签（`FLOW_MAX_VLAN_HEADERS`），`parse_vlan()`（`flow.c:349`）循环剥标签。

### STP BPDU

STP 使用「桥协议数据单元」BPDU（IEEE 802.1D 定义），经由 MAC 地址
`01-80-C2-00-00-00`（bridge 组播）发送，被其他桥监听但**不被普通转发**（这是「隔离」的
一部分：控制帧与数据帧分离）。OVS 的 STP 在 `ofproto-dpif.c` 的 `stp_run()` 周期驱动，
实际 BPDU 构造与解析在未复制的 `stp.*` / `rstp.*` 模块中完成。

### LACP PDU

LACP（IEEE 802.3AX）使用 MAC 地址 `01-80-C2-00-00-01`（slow-protocol 组播），
EtherType `0x8809`（`send_pdu_cb` 中 `eth_addr_lacp` 与 `ETH_TYPE_LACP`）。
慢协议（slow protocols）要求速率受限（每秒数包），与 LLDP 共享同一速率限制框架。

### LLDP

LLDP（IEEE 802.1AB）使用 MAC `01-80-C2-00-00-0E`，EtherType `0x88CC`；以 TLV 结构
通告邻居信息（chassis/port ID、TTL、系统能力等）。OVS 用 `ovs-lldp.h` 的 `lldp_create()`
为每个端口创建实例（`ofproto-dpif.c:2501`）。

## 核心机制

### MAC 学习

透明桥不配置路由表，而是被动学习：

1. 每个端口收到帧后，把 `(src MAC, VLAN)` 记入学习表，关联到入端口。
2. 转发时查 `(dst MAC, VLAN)`：命中则只向对应端口发送（若该端口即入端口则丢弃/不回环）；
   未命中则向同 VLAN 的其余端口泛洪。
3. 学习表按 LRU + 空闲时间老化（`MAC_ENTRY_DEFAULT_IDLE_TIME`），STP 拓扑变化或
   bundle 变化时整体冲刷（`mac_learning_flush()`）。

OVS 的学习动作通过 OpenFlow `learn` action 实现，经 `xlate_cache` 延迟到出包路径
（`packet_xlate` 中 `XC_LEARN` 条目）批量提交。

### VLAN 隔离

- 端口配置为「接入（access）」或「干道（trunk）」。接入端口有单一 `vlan` 值；
  干道端口 `vlan == -1`，用 `trunks`（4096 位 bitmap，`vlan-bitmap.c`）记录放行的 VLAN 集。
- 标签处理：接入端口可在入站剥掉标签、出站贴标签（`qinq_ethtype` 用于 Q-in-Q 嵌套标签）。
- 不变量：**帧只能在允许的 VLAN 内流动**；不允许 VLAN 的帧在进入时被丢弃，
  保证隔离域不变。

### STP

目标：给定冗余桥拓扑，STP 为每个 bridge 生成一棵生成树，把非树端口置为 `Blocking`，
树端口进入 `Forwarding`，从而消除环路。详见 `state-machine.md`。

OVS 的 STP 是 802.1D 的完整状态机，逐端口状态存在 `ofport_dpif.stp_state`，
由 `stp_run()`（`ofproto-dpif.c:2975`）周期推进；STP 状态变化会：
- 冲刷 MAC 学习表（学习状态变化时，`update_stp_port_state` 中 `mac_learning_flush`）；
- 改变 bundle 的 flood 能力（`bundle_update` 检查各端口是否 `stp_forward_in_state`）。

### LACP 聚合

- 多个端口组成 `bundle`；LACP 交换 PDU 判定成员活性与链路能力，维护「可用成员集」。
- `bundle_run()`（`ofproto-dpif.c:3613`）周期调用 `lacp_run()`，PDU 经 `send_pdu_cb`
  打包成 802.3AX 帧（`eth_compose(..., ETH_TYPE_LACP)`）发送。
- 聚合在数据平面体现为：学习表条目关联到 bundle 而非单个端口（`mac_entry_get_port`），
  发往该 bundle 的帧可负载均衡到任一可用成员（`bond_run`）。
- LACP 与 STP 协同：非 Forwarding 的 STP 端口不参与 bundle 泛洪（`bundle_update`）。

### LLDP

管理平面：`ofproto-dpif.c` 的 `set_lldp()` 创建/配置端口 LLDP 实例，`get_lldp_status()`
上报邻居信息。LLDP 不参与转发决策，是「可观测性」而非「连通性」机制。

## 设计取舍

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 转发方式 | 透明桥（不配置路径，被动学习） | 即插即用；代价是学习冷启动期泛洪与环路风险 |
| 环路处理 | STP 生成树（而非禁用冗余链路） | 保留冗余链路的故障切换能力，但引入状态机复杂度 |
| 控制帧 | 使用 bridge/slow 组播 MAC 且不与数据帧同路径 | 控制面与数据面解耦，可独立节流（LACP/LLDP 共限速） |
| 隔离粒度 | `(MAC, VLAN)` 双键学习表 | VLAN 是隔离域的键，MAC 是转发域的键 |
| 聚合 | LACP 单逻辑链路 + 成员级可用性 | 对上层透明，保持寻址语义不变 |
| 学习提交 | OpenFlow learn action + xlate cache 延迟批量提交 | 把学习副作用从数据路径移到可批量的位置 |

## 不变量

1. **隔离不变量**：任意帧只能在它 VLAN 的允许集合内被转发；干道端口的 `trunks`
   与接入端口的 `vlan` 构成完整约束。
2. **无环不变量**：STP 运行收敛后，活动（Forwarding）链路构成树，无活动环。
3. **学习一致性**：`(MAC, VLAN) → bundle` 映射在同一 `(MAC, VLAN)` 上有且仅有一个
   bundle；新学习覆盖旧条目。
4. **泛洪边界**：泛洪只发生在同 VLAN、且非入端口、且所有端口处于 Forwarding 时
   （`bundle_update` 保证）。
5. **状态-行为一致**：端口 STP 状态与其「是否学习/是否转发」严格一致
   （`stp_learn_in_state` / `stp_forward_in_state` 派生）。

## 边界条件与异常处理

- **学习表满**：按 LRU 驱逐最久未用条目；被驱逐的转发路径回到泛洪。
- **端口配置为 No-Flood / legacy L3**：该端口不参与泛洪也不影响 bundle floodable
  标志，避免泄露到广播域之外。
- **未知单播 / 广播 / 组播**：泛洪；组播还受 `mcast_snooping` 限制（可选）。
- **STP 状态转移**：任何进入/离开学习/转发状态都会触发学习表冲刷
  （`update_stp_port_state`），防止旧路径残留。
- **LACP 成员失效**：`lacp_member_carrier_changed` 更新成员可用性；若 bundle 所有
  成员失效，学习条目被移除（`bundle_flush_macs`），流量经 STP 树路径切换。
- **帧过短/畸形（长度 < 14B 无法含 EtherType）**：`parse_vlan` / `parse_ethertype`
  在数据不足时返回 `FLOW_DL_TYPE_NONE`，不进入 VLAN 匹配。
- **嵌套 VLAN 上限**：`flow_vlan_limit` 限制标签嵌套深度，超出即停止解析。
- **VLAN 4095 保留值**：`VLAN_VID_MASK` 掩掉 TCI 中的保留位，匹配时以 12 位 VID 为准。
- **LLDP 配置失败**：`lldp_configure` 返回 false 时 `set_lldp` 释放实例，端口退回
  无 LLDP 状态，不阻塞数据面。