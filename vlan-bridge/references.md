# VLAN / bridge / STP / LACP / LLDP · references

## 规范 / 标准

| 规范 | 内容 |
| --- | --- |
| IEEE 802.1Q | 虚拟桥接局域网（VLAN）；TCI 格式、PCP/DEI/VID、802.1p 优先级标签 |
| IEEE 802.1D | MAC 桥（透明桥）：MAC 学习、生成树（STP）、泛洪/转发规则、BPDU |
| IEEE 802.3AX / IEEE 802.1AX | 链路聚合（Link Aggregation）：LACP、聚合组、成员状态机、慢协议帧 |
| IEEE 802.1AB | 链路层发现协议（LLDP）：邻居发现、TLV、TTL 与能力通告 |
| IEEE 802.1D STP 状态 | Blocking / Listening / Learning / Forwarding / Disabled，与计时器语义 |

相关 EtherType 与组播地址速查：

| 项 | 值 |
| --- | --- |
| 802.1Q TPID | `0x8100` |
| LACP / slow-protocol 组播 MAC | `01-80-C2-00-00-01`，EtherType `0x8809` |
| LLDP 组播 MAC | `01-80-C2-00-00-0E`，EtherType `0x88CC` |
| STP / bridge 组播 MAC | `01-80-C2-00-00-00` |

## 论文

- Radia Perlman, Radia Perlman 等，《An Algorithm for Distributed Computation of a
  Spanning Tree in an Extended LAN》（1985）——生成树在扩展局域网上的分布式计算，
  STP 的理论基础。
- IEEE 802.1D-2004 / 802.1Q-2005 标准文本内的「透明桥转发模型」章节。

## 上游仓库（固定版本 / commit）

| 项 | 值 |
| --- | --- |
| 主实现仓库 | `https://github.com/openvswitch/ovs` |
| 固定 tag | `v2.17.0` |
| 复制方式 | 从 `https://raw.githubusercontent.com/openvswitch/ovs/v2.17.0/<path>` 逐个下载 |
| 许可证 | Apache License 2.0，见 `src/LICENSES/LICENSE`（上游根 `LICENSE` 文件，含版权声明） |
| 未复制文件说明 | VLAN 标签解析在 `lib/flow.c`；STP 引擎（`stp.*`/`rstp.*`）、LACP 引擎（`lacp.*`）、LLDP（`ovs-lldp.*`）、xlate 核心（`ofproto-dpif-xlate.c`）、upcall 收包循环（`ofproto-dpif-upcall.c`）均未复制，属依赖模块，见 `src/README.md` |

## 其他实现

| 实现 | 说明 |
| --- | --- |
| Linux kernel `bridge` / `vlan` / `bonding` | 内核对照实现：`brctl`/`ip link add type bridge`、VLAN 接口、`bond` 驱动与 `LACP`（仅被动模式） |
| `bridge` 模块（man 页面 `brctl`、`ip` 工具手册） | 观察真实系统上 MAC 学习表（`brctl showmacs`）与 VLAN 配置的对照 |
| 其他交换机 OS（Cumulus、FRR `zebra` 等） | 不涉及链路层，不在此比较 |

## 阅读备注

- **OVS 的 STP 是完整的 802.1D 实现**（含 `stp` 与 `rstp` 两套），但引擎在
  `ofproto/stp.c` 与 `ofproto/rstp.c`（本模块未复制）；`ofproto-dpif.c` 只负责
  「周期驱动 + 状态同步 + 副作用（学习表冲刷、bundle 更新）」。阅读时以
  `stp_run()` → `update_stp_port_state()` 为锚点，把状态机与数据平面连接起来。
- **LACP 的 PDU 编解码在 `ofproto/lacp.c`**；`ofproto-dpif.c` 中的 `send_pdu_cb`
  演示了「引擎产出 PDU → OVS 打包成 802.3AX 帧 → `ofproto_dpif_send_packet` 送出」
  的完整出口路径。
- **VLAN 是 OVS 流表匹配字段**：`flow.c` 把标签解析进 `struct flow.vlans[]`，
  学习表、流表、`trunks` bitmap 三处共享同一 12 位 VID 空间，读 `vlan-bitmap.h` 时
  注意其「NULL 表示全部/全部不」的语义。
- **对照 Linux bridge**：Linux 的 `bridge` 用「per-bridge 全局表」，VLAN 过滤发生在
  `brctl` 的 per-port membership；OVS 用「(MAC, VLAN) 双键表 + 流表」，学习与转发
  都被 OpenFlow 动作（`learn` action）统一。这个差异是「交换机式」与「路由式」转发的
  一个具体对照点。
- **LACP 与 STP 的耦合**：`bundle_update` 把端口 STP 状态纳入泛洪判定，说明链路层
  各协议不是孤立的；聚合组内的流量路径仍受生成树约束。