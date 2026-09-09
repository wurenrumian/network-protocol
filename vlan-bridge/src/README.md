# VLAN / bridge / STP / LACP / LLDP · src

## 上游版本

- 仓库：`https://github.com/openvswitch/ovs`
- 固定 tag：**v2.17.0**
- 许可证：Apache License 2.0（`../LICENSES/LICENSE`，上游根 `LICENSE` 文件）

## 文件清单（文件 → 类别 → 阅读范围）

下表与实际复制进 `upstream/` 的文件一一对应。类别按 `protocol-learning-design.md`
§3 的 `core/` / `integration/` / `platform/` 标记。

### `upstream/ofproto/ofproto-dpif.c`（core/integration，主文件）

| 条目 | 类别 | 阅读范围（行号） | 职责 |
| --- | --- | --- | --- |
| `struct ofproto_dpif`、`struct ofbundle`、`struct ofport_dpif` | core | 58–240 | bridge / bundle / port 抽象定义 |
| `run()` | core | 1864–2000 | 所有周期控制（STP、RSTP、LACP、MAC 学习）的统一入口 |
| `stp_run()` / `rstp_run()` | core | 2975 / 2716 | STP/RSTP 周期驱动与 FDB 冲刷 |
| `update_stp_port_state()` | core | 2816–2860 | STP 状态同步：学习表冲刷、bundle 更新、OpenFlow 状态位 |
| `set_stp()` / `set_stp_port()` | integration | 2760 / 2893 | STP 配置入口 |
| `bundle_run()` / `bundle_update()` / `bundle_add_port()` | core | 3613 / 3173 / 3210 | LACP/bond 聚合：PDU 驱动与泛洪判定 |
| `send_pdu_cb()` | core | 3531–3549 | LACP PDU 打包成 802.3AX 帧出口 |
| `set_lldp()` / `get_lldp_status()` | integration | 2491 / 2524 | LLDP 实例配置与状态上报 |
| `set_flood_vlans()` | core | 3695 | 泛洪 VLAN 集合配置 |
| `mac_learning_run()` 相关 | core | 1928, 2005 | 学习表周期老化 / 唤醒 |
| `bundle_flush_macs()` / `bundle_move()` | core | 3105 / 3140 | 学习条目在 bundle 间迁移/清除 |
| `ofproto_dpif_execute_actions()` | integration | 4244–4310 | flow lookup 后动作执行（xlate → `dpif_execute`） |
| `rule_dpif_lookup_*` / `classifier_lookup` | core | 4391–4560 | 流表查找（`table_id` 链） |
| `packet_xlate()` | integration | 4849–4910 | 转发路径中的 xlate 与 `XC_LEARN` 学习副作用批量提交 |
| `packet_execute_prepare()` / `packet_execute()` | integration | 4984 / 5019 | 出包执行（与 `xlate_cache` 配合） |
| `nxt_resume()` | integration | 5718 | 控制平面挂起包继续处理（含 xlate + `dpif_execute`） |
| `ofproto_dpif_send_packet()` | integration | 5312 | 出口统一封装（`xlate_send_packet` → 统计） |
| `ofproto_dpif_class` | integration | 6809–6916 | 将上述函数注册为 `ofproto` 类回调表 |

### `upstream/lib/dpif.c`（integration/platform）

| 条目 | 类别 | 阅读范围 | 职责 |
| --- | --- | --- | --- |
| `dpif_class` / `registered_dpif_class` | integration | 71–102 | datapath 实现类的注册机制 |
| `dpif_open/create/close/run/wait` | platform | 390–475 | datapath 生命周期与 poll 循环 |
| `dpif_recv_set()` / `dpif_recv()` / `dpif_recv_purge()` | platform | 1454 / 1610 / 1635 | 收包（upcall 机制）入口 |
| `dpif_flow_get()` / `dpif_flow_del()` / `dpif_flow_flush()` | core | 989 / 1046 / 926 | 流表查询/删除/清空 |
| `dpif_execute()` | core | 见调用处（`ofproto-dpif.c` 引用） | 对 datapath 提交动作 |

### `upstream/lib/netdev.c`（platform/integration）

| 条目 | 类别 | 阅读范围 | 职责 |
| --- | --- | --- | --- |
| `netdev` 类注册与查找 | platform | 71–100, 224–294 | 端口设备抽象注册表 |
| `netdev_open` 相关 | platform | 471–546 | 打开/配置网络设备 |
| `netdev_send_prepare_packet/batch`、`netdev_send` | platform | 792–884 | 发送主路径（含 batch、qid） |
| `netdev_rxq_*` | platform | 698 | 接收队列句柄 |
| `netdev_get_etheraddr` / `netdev_get_pt_mode` 等 getter | platform | 全文件 | 端口属性读取（STP/LACP 出口依赖） |

### `upstream/lib/vlan-bitmap.c` / `vlan-bitmap.h`（core）

| 条目 | 类别 | 阅读范围 | 职责 |
| --- | --- | --- | --- |
| `vlan_bitmap_from_array()` / `vlan_bitmap_equal()` / `vlan_bitmap_clone()` | core | 全文件 | 4096 位 VLAN 集合 bitmap；`NULL` 表示全含/全不含 |

### `upstream/lib/flow.c`（core）

| 条目 | 类别 | 阅读范围 | 职责 |
| --- | --- | --- | --- |
| `parse_vlan()` | core | 349–380 | 802.1Q 标签循环解析（`flow_vlan_limit` 嵌套上限） |
| `parse_ethertype()` | core | 382–420 | EtherType / LLC-SNAP 解析 |
| `flow_extract()` | core | 634 起 | 从包提取 `struct flow` 关键字段 |
| `flow_hash_*` / `flow_wildcards_*` | core | 1818–2660 | 流匹配哈希与通配 |
| `flow_vlan_limit` | core | 66 | VLAN 嵌套上限（默认 `FLOW_MAX_VLAN_HEADERS`） |

### `src/LICENSES/LICENSE`

上游 `LICENSE` 文件原样复制（Apache License 2.0 全文 + OVS 版权声明）。

## 阅读顺序与调用链

按 `protocol-learning-design.md` §3 的「闭环优先」原则，先完成转发闭环，再沿控制链补
integration/platform：

### 转发闭环（data plane）

```text
收包：netdev 收到帧（netdev.c 的 rxq / dpif.c 的 dpif_recv upcall）
  → 提取 flow：lib/flow.c 的 flow_extract()（含 parse_vlan() 解析 802.1Q 标签）
  → 流表查找：ofproto-dpif.c 的 rule_dpif_lookup_in_table()（classifier_lookup，
     以 (MAC, VLAN, ...) 为 key）
  → 执行动作：ofproto-dpif.c 的 ofproto_dpif_execute_actions()
     （xlate_actions → 构造 struct dpif_execute）
  → 提交 datapath：lib/dpif.c 的 dpif_execute()
  → 出端口：ofproto-dpif.c 的 ofproto_dpif_send_packet()
     （xlate_send_packet → netdev_send，见 netdev.c）
```

### STP 控制闭环（control plane）

```text
入口：run()（ofproto-dpif.c:1864）
  → stp_run()（:2975）
      → stp_tick() + stp_check_and_update_link_state()
      → stp_get_changed_port() 逐个取变化端口
      → update_stp_port_state()（:2816）
          → 学习能力变化 → mac_learning_flush()
          → 转发能力变化 → bundle_update() + need_revalidate=REV_STP
  → 出口：OpenFlow 端口状态位更新（ofproto_port_set_state）
```

### LACP / LLDP 控制闭环

```text
run() → bundle_run()（:3613）
  → lacp_run(bundle->lacp, send_pdu_cb)   // PDU 生成
  → send_pdu_cb()（:3531）                 // eth_compose 成 802.3AX 帧
  → ofproto_dpif_send_packet()            // 出口
LLDP：set_lldp()（:2491）→ lldp_create()/lldp_configure()；get_lldp_status() 上报
```

## 入口函数 / 结束函数

| 路径 | 入口 | 结束 |
| --- | --- | --- |
| 转发 | `dpif_recv()` → `flow_extract()` → `rule_dpif_lookup_*` | `dpif_execute()` → `ofproto_dpif_send_packet()` → `netdev_send()` |
| STP | `run()` → `stp_run()` | `update_stp_port_state()`（副作用收尾） |
| LACP | `run()` → `bundle_run()` → `lacp_run()` | `send_pdu_cb()` → `ofproto_dpif_send_packet()` |
| MAC 学习 | `run()` → `mac_learning_run()`；数据路径 `packet_xlate()` 的 `XC_LEARN` | `mac_learning_flush()` / `bundle_flush_macs()` |

## 未复制的依赖

以下模块参与上述闭环但**未复制**（按 §3 只记录依赖、不复制无关功能），需要时到
上游 v2.17.0 对应路径单独查看：

| 模块 | 上游路径 | 在闭环中的角色 |
| --- | --- | --- |
| STP 引擎 | `ofproto/stp.c` / `stp.h`、`ofproto/stp-*` | BPDU 编解码与状态机（`stp_tick` / `stp_get_changed_port` / `stp_*` 全部来自这里） |
| RSTP 引擎 | `ofproto/rstp.c` / `rstp.h`、`ofproto/rstp-*` | 802.1Q 快速生成树状态机 |
| LACP 引擎 | `ofproto/lacp.c` / `lacp.h`、`ofproto/lacp-*` | PDU 编解码、成员状态机（`lacp_run` / `lacp_member_*`） |
| bond 逻辑 | `ofproto/bond.c` / `bond.h` | 聚合负载均衡与学习包（`bond_run` / `bond_should_send_learning_packets`） |
| LLDP | `ofproto/ovs-lldp.c` / `ovs-lldp.h` | `lldp_create` / `lldp_configure` / `lldp_unref` 实现 |
| xlate 核心 | `ofproto/ofproto-dpif-xlate.c` / `xlate.h` | `xlate_actions` / `xlate_send_packet` / `xlate_add_*`（flow → datapath action 翻译） |
| xlate cache | `ofproto/ofproto-dpif-xlate-cache.c` / `.h` | `XC_LEARN` 学习副作用缓存与批量执行 |
| upcall 收包循环 | `ofproto/ofproto-dpif-upcall.c` / `.h` | `dpif_upcall` 处理：把 `dpif_recv` 上访转为流表/学习处理 |
| MAC 学习表 | `ofproto/ofproto-dpif-mac-learning.c` / `.h`（或 `lib/mac-learning.*`） | `mac_learning_*` 实现 |
| 组播侦听 | `ofproto/ofproto-dpif-mcast-snooping.c` / `.h` | `mcast_snooping_*` |
| flow 结构定义 | `lib/flow.h`（含 `struct flow`、`union flow_vlan_hdr`、`FLOW_MAX_VLAN_HEADERS`） | `flow.c` 的编译依赖；`struct flow.vlans[]` 定义 |
| 公共基础 | `lib/bitmap.*`、`lib/dp-packet.*`、`lib/poll-loop.*`、`lib/vlog.*`、`lib/ovs-thread.*` 等 | 数据结构与事件循环基础，不属本模块阅读范围 |

## 已复制 / 跳过说明

- **已复制**（`upstream/`，共 6 个文件）：`ofproto/ofproto-dpif.c`、
  `lib/dpif.c`、`lib/netdev.c`、`lib/vlan-bitmap.c`、`lib/vlan-bitmap.h`、`lib/flow.c`；
  `src/LICENSES/LICENSE`（上游 `LICENSE`，Apache-2.0）。
- **原任务清单中的 `lib/vlan.c` / `lib/vlan.h` 在 v2.17.0 不存在**（404）。
  通过 v2.17.0 git tree 核查，VLAN 处理实际位于 `lib/vlan-bitmap.c` / `lib/vlan-bitmap.h`，
  已改下载这两个文件，未伪造 `vlan.c`/`vlan.h` 内容。
- **未复制**：STP/RSTP/LACP/bond/LLDP/xlate/upcall/MAC-learning 引擎及其头部，
  以及 `lib/flow.h` 等编译依赖（见上表），原因是它们属于「可独立追踪的协议引擎」或
  「通用基础」，在本模块闭环中被 `ofproto-dpif.c` 消费但不承载本模块的核心数据平面。
- **上游源码未做任何改动**；学习注释格式按 `protocol-learning-design.md` §3，未来如需
  在副本上标注，遵循 `[RFC]` / `[STATE]` / `[INVARIANT]` / `[BOUNDARY]` 格式。