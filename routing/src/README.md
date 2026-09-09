# 路由 / 转发 / NAT / Netfilter / Conntrack · src

本页是源码导航页，不复述协议内容。它维护：上游版本、文件清单（文件 → 类别 → 阅读范围）、阅读顺序与调用链、入口/结束函数、未复制的依赖、已复制/跳过说明。

## 上游版本

| 项 | 值 |
| --- | --- |
| 仓库 | FRRouting/frr，`https://github.com/FRRouting/frr` |
| tag | **`frr-8.5.1`**（`raw.githubusercontent.com/FRRouting/frr/frr-8.5.1/<path>` 全部返回 200） |
| 许可证 | GPL v2，`src/LICENSES/COPYING`（18 KB，GNU GPL Version 2, June 1991） |
| 覆盖 | 路由控制面（OSPF/BGP/zebra RIB） |

转发/NAT/conntrack 属 **Linux 内核**，不在本模块复制范围，只记录路径（见下"未复制的依赖"）。

## 文件清单（文件 → 类别 → 阅读范围）

| 文件（`src/upstream/` 下相对路径） | 类别 | 阅读范围 | 上游原始路径 |
| --- | --- | --- | --- |
| `ospfd/ospf_packet.c` | core | OSPF 报文收发：`ospf_read_helper`（收包解析、邻居状态机驱动）、`ospf_write`（发包构造）；认证/加密分支略读 | `ospfd/ospf_packet.c` |
| `ospfd/ospf_flood.c` | core | LSA 泛洪扩散与 LSU 发送路径；与 `ospf_lsa.c` 配合维护洪泛表 | `ospfd/ospf_flood.c` |
| `ospfd/ospf_lsa.c` | core | LSA 生命周期：`ospf_router_lsa_new`（创建本区 LSA）→ `ospf_router_lsa_originate`（originate）→ `ospf_router_lsa_refresh`（周期性刷新），洪泛表操作 | `ospfd/ospf_lsa.c` |
| `bgpd/bgp_packet.c` | core | BGP 报文：`bgp_packet_set_marker`/`bgp_packet_set_size`（头构造）、`bgp_packet_add`（长度回填）、`bgp_write_proceed_actions`/`bgp_write_notify`（发送路径）；stalepath 定时器略读 | `bgpd/bgp_packet.c` |
| `bgpd/bgp_fsm.c` | core | BGP 会话状态机：`bgp_start_timer`（定时器）、`bgp_connect_success`（Connect→OpenSent）、`bgp_clearing_completed`/`bgp_stop_with_error`（回 Idle） | `bgpd/bgp_fsm.c` |
| `zebra/zebra_rib.c` | core/integration | RIB 维护：`rib_process`（路由条目决策）、`rib_process_dplane_notify`（数据平面通知→查表更新）、`rib_process_result`（下发结果）；`zebra_rib_evaluate_mpls` 等标签/MPLS 分支略读 | `zebra/zebra_rib.c` |

分类口径（§3）：core = 协议本身（报文、状态机、泛洪、RIB）；integration = 与其他子系统连接（`zebra_rib.c` 中 RIB → 数据平面接口 `zebra_dplane_ctx` 部分）；platform 在本模块未复制（FRR 的平台适配在 `lib/`、`configure` 脚本，不在阅读范围）。

## 阅读顺序与调用链

控制面按"先终点、后来源"的原则，先建立 RIB 心智模型，再回到协议输入：

```text
1. zebra/zebra_rib.c         RIB 结构：条目(route_entry)、目的地、队列与下发决策
   → rib_process / rib_process_dplane_notify   路由安装/撤销主路径
2. ospfd/ospf_lsa.c          LSA 对象：生成、originate、refresh、洪泛表
   → ospf_router_lsa_new → ospf_router_lsa_originate → ospf_router_lsa_refresh
3. ospfd/ospf_flood.c        LSU 泛洪：把 LSA 差异扩散到邻居
4. ospfd/ospf_packet.c       报文入/出口：ospf_read_helper（收+状态机）→ ospf_write（发）
5. bgpd/bgp_fsm.c            BGP 会话状态机：连接建立 → 状态转移
   → bgp_connect_success → Established 后的 UPDATE 交换
6. bgpd/bgp_packet.c         BGP 报文构造/解析：bgp_packet_set_marker/set_size → bgp_packet_add
```

调用链（输入 → 输出）概要：

```text
OSPF:  收 UDP(IP proto 89) → ospf_read_helper 解析头/认证
       → 邻居状态机推进(Hello/DBD/LSU) → LSA 写入 → 泛洪(ospf_flood)
       → RIB 更新(zebra) → 下发数据平面(rib_process_dplane_notify)
BGP:   TCP 数据 → bgp_packet 切帧/解析 → bgp_fsm 状态推进
       → Established 后 UPDATE → RIB 更新(zebra) → 下发数据平面
```

## 入口函数 / 结束函数

| 文件 | 入口函数 | 结束函数 |
| --- | --- | --- |
| `ospfd/ospf_packet.c` | `ospf_read_helper`（收包解析、邻居状态机驱动的统一入口）；`ospf_write`（发包构造入口） | 各报文处理函数；`ospf_write` 完成发送 |
| `ospfd/ospf_flood.c` | 泛洪/LSU 发送路径入口（洪泛表驱动的发送循环） | LSU 发送完成 / Ack 处理 |
| `ospfd/ospf_lsa.c` | `ospf_router_lsa_new` → `ospf_router_lsa_originate` | `ospf_router_lsa_refresh`（周期刷新，连接回 next refresh 定时器） |
| `bgpd/bgp_packet.c` | `bgp_packet_set_marker` / `bgp_packet_set_size` / `bgp_packet_add`（报文构造起点）；`bgp_write_proceed_actions` / `bgp_write_notify`（发送路径） | 报文发送完成 / `bgp_refresh_stalepath_timer_expire`（stalepath 清理） |
| `bgpd/bgp_fsm.c` | `bgp_start_timer`（定时器启动）；`bgp_connect_success` / `bgp_clearing_completed` / `bgp_stop_with_error`（状态转移入口） | Established 后回到事件循环；回 Idle 断开 |
| `zebra/zebra_rib.c` | `rib_process`（路由决策主入口）；`rib_process_dplane_notify`（数据平面通知入口） | `rib_process_result`（下发结果）；`rib_re_nhg_free`（条目释放） |

## 未复制的依赖

- **FRR 内部基础库**（未复制，阅读 `src/upstream/` 时通过函数名识别）：`lib/stream`、`lib/thread`、`lib/queue`、`lib/prefix`、`lib/linklist`、`lib/table`、`lib/sockopt`、`lib/filter`、`lib/plist`、`lib/hash`、`lib/memory`、`lib/if_rmap`、`lib/nsm` 等。它们提供 `stream/thread/prefix/route_node` 等类型，是 FRR 的平台/工具层，不在本模块闭环内。
- **FRR 构建与平台适配**（未复制）：`configure`、`Makefile`、`lib/.libs` 等；本模块不编译，仅阅读。
- **转发 / NAT / conntrack（Linux 内核）**（未复制，概念对照，`protocol.md` 引用）：
  - `net/netfilter/nf_conntrack_core.c` — conntrack 状态跟踪核心
  - `net/netfilter/nf_nat_core.c`、`nf_nat_*.c` — NAT 映射
  - 三层转发与转发表查表路径（`net/ipv4/ip_forward.c` / `route.c` 相关）
  - 完整路径以本地内核源码树或 kernel.org 为准。

## 已复制 / 跳过说明

- **已复制**（全部来自 `FRRouting/frr` @ `frr-8.5.1`，保持原始相对路径）：上表 6 个文件 + `src/LICENSES/COPYING`（GPL v2）。下载全部返回 HTTP 200，无 404 跳过项。
- **跳过**：内核源码（本模块数据面部分只作概念对照，不复制）；FRR 的 `lib/`、`ospfd`/`bgpd` 其余文件、`zebra` 其余文件、测试与构建文件（不在闭环内）。
- **注释约定**：在 `src/upstream/` 副本上加学习注释时，使用 `/* [RFC: section-x] ... */`、`/* [STATE] ... */`、`/* [INVARIANT] ... */`、`/* [BOUNDARY] ... */` 标记，不改动控制流与命名；修改仅限学习注释，不伪装成上游改动（见根 `protocol-learning-design.md` §3）。