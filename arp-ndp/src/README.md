# ARP / IPv6 NDP · src

## 上游版本

- 上游仓库：`github.com/lwIP-tcpip/lwip`
- 固定版本：**STABLE-2_1_3_RELEASE**（2021-11-10）
- 固定 commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：BSD-3-Clause（`COPYING`，见 `LICENSES/`）

本目录 `upstream/` 下保留与闭环相关的完整上游文件，保留原相对路径；学习注释只加不改。注意：上游 2.1.3 中 ARP 实现位于 `src/core/ipv4/etharp.c`（不是旧路径 `src/netif/etharp.c`），`src/include/netif/etharp.h` 仅为向后兼容 shim。

## 文件清单（文件 → 类别 → 阅读范围）

### core/（协议本身，先读）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/core/ipv4/etharp.c` | core | 全文：ARP 表结构、`etharp_find_entry`/`etharp_update_arp_entry`/`etharp_query`/`etharp_output`/`etharp_input`/`etharp_tmr`/`etharp_raw`。跳过 SNMP/autoip/dhcp 钩子段只须理解其作用。 |
| `src/core/ipv6/nd6.c` | core | 全文：邻居/目标/路由器/前缀四表与 `nd6_input`/`nd6_tmr`/`nd6_send_ns`/`nd6_send_na`/`nd6_get_next_hop_entry`/`nd6_get_next_hop_addr_or_queue`/`nd6_reachability_hint`/`nd6_duplicate_addr_detected`。 |
| `src/core/ipv6/ethip6.c` | core | 全文（123 行）：Ethernet 网卡的 `output_ip6`，单播 → `nd6_get_next_hop_addr_or_queue`，多播 → 33:33 映射后 `ethernet_output`。 |
| `src/include/lwip/etharp.h` | core | 全文：ARP API、`ARP_TMR_INTERVAL`、`etharp_gratuitous` 宏。 |
| `src/include/lwip/nd6.h` | core | 全文：NDP API。 |
| `src/include/lwip/priv/nd6_priv.h` | core | 全文：四表结构、`enum nd6_neighbor_cache_entry_state`、队列结构。 |
| `src/include/lwip/prot/etharp.h` | core | 全文：`struct etharp_hdr`（28 字节报文）、`enum etharp_opcode`。 |
| `src/include/lwip/prot/nd6.h` | core | 全文：NS/NA/RS/RA/RD 头结构、NDP option 定义（LLADDR/Prefix/MTU/RDNSS）、ND6_FLAG_*。 |
| `src/include/lwip/prot/icmp6.h` | core | 全文：ICMPv6 类型枚举（含 133-137）。 |

### integration/（与 IP、ICMP、网卡分发连接）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/core/ipv6/icmp6.c` | integration | 只读分发段（`icmp6_input` 的 switch，ND 类型 → `nd6_input`）与校验段。 |
| `src/netif/ethernet.c` | integration | 只读分发段（`ethernet_input`：ETHTYPE_ARP → `etharp_input`；ETHTYPE_IPV6 → `ip6_input`）与 `ethernet_output`（收尾发送）。 |
| `src/core/ipv4/ip4.c` | integration | 只读出口（`ip4_output` → `etharp_output`）与 `ip4_input` 的位置，不深入路由/分片。 |
| `src/core/ipv6/ip6.c` | integration | 只读出口（`ip6_output_if_src` → `netif->output_ip6`）与入口（`ip6_input` → `icmp6_input`），不深入扩展头/分片。 |

### platform/（网卡抽象，只读支撑结论部分）

| 文件 | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/include/lwip/netif.h` | platform | 只读 `struct netif`（`output_ip6` 函数指针、`hwaddr_len`、`hwaddr`）、`netif_ip6_addr_state` 等地址状态访问器。 |
| `src/include/lwip/ip6_addr.h` | platform | 只读地址状态位（`IP6_ADDR_TENTATIVE*`/`VALID`/`DUPLICATED`）。 |

## 阅读顺序与调用链

建议按两条闭环组织（先 core/ 后 integration/）：

### 闭环 1：ARP（IPv4 发送 → 解析 → 应答 → 出队）

```
ip4_output                                [ip4.c]
  └─ etharp_output(netif, q, ipaddr)      [etharp.c]   出口
       ├─ 广播 → 直接 ethernet_output
       ├─ 多播 → 01-00-5E 映射 → ethernet_output
       └─ 单播 → 查 ARP 表
            ├─ 命中 → etharp_output_to_arp_index → ethernet_output
            └─ 未命中 → etharp_query:
                 etharp_find_entry(TRY_HARD)  → EMPTY→PENDING
                 etharp_request → etharp_raw（广播 REQUEST）
                 nd6/ARP 排队: arp_table[i].q（IP 包入队）

收帧: ethernet_input                        [ethernet.c]
  └─ ETHTYPE_ARP → etharp_input(p, netif)   [etharp.c]   入口
       ├─ 校验 hwtype/hwlen/proto/protolen（不符丢）
       ├─ etharp_update_arp_entry（学发送者映射）
       ├─ REQUEST: for_us → etharp_raw(ARP_REPLY)
       └─ REPLY: （映射已写入）
  └─ 写入成功 → etharp_update_arp_entry:
       PENDING→STABLE, ctime=0, 出队 ethernet_output（闭环闭合）

1s 定时: etharp_tmr                        [etharp.c]    老化/重发/续期
```

### 闭环 2：NDP（IPv6 发送 → 解析 → NA → 状态推进 → 出队）

```
ip6_output_if_src                          [ip6.c]
  └─ netif->output_ip6(netif, p, dest)
       └─ ethip6_output                     [ethip6.c]   出口
            ├─ 多播 → 33:33:xx:xx:xx:xx → ethernet_output
            └─ 单播 → nd6_get_next_hop_addr_or_queue
                 └─ nd6_get_next_hop_entry  [nd6.c]      目标缓存→邻居缓存
                      ├─ 命中 REACHABLE/DELAY/PROBE → 返回 lladdr，立即发
                      ├─ 命中 STALE → 置 DELAY，返回 lladdr，立即发
                      └─ 未命中 → 新建 INCOMPLETE + 多播 NS
                                  → nd6_queue_packet（入队）

收帧: ethernet_input                        [ethernet.c]
  └─ ETHTYPE_IPV6 → ip6_input               [ip6.c]
       └─ IP6_NEXTH_ICMP6 → icmp6_input     [icmp6.c]
            └─ type 135/136/134/137/2 → nd6_input   [nd6.c]   入口
                 ├─ 校验（Hop Limit=255、code=0、长度）
                 ├─ NA: 邻居项 → REACHABLE, reachable_time 重置
                 │        → nd6_send_q（出队，闭环闭合）
                 ├─ NS: 为我们? → 更新/新建邻居项(DELAY) → 单播 NA
                 │      DAD?（src=::）→ 回 NA + 标记重复
                 ├─ RA: 默认路由器/前缀/MTU/RDNSS 更新
                 ├─ RD: 目标缓存下一跳更正
                 └─ PTB: 目标缓存 PMTU 更新

1s 定时: nd6_tmr                            [nd6.c]      状态机推进 + DAD + RS
```

## 入口函数 / 结束函数

| 闭环 | 入口 | 结束（出口） |
| --- | --- | --- |
| ARP 收包 | `etharp_input(p, netif)`（`ethernet.c:205` 调） | 应答：`etharp_raw(…, ARP_REPLY)` → `ethernet_output`；学习：`etharp_update_arp_entry` 出队发送排队 IP 报文 |
| ARP 发包 | `etharp_output(netif, q, ipaddr)`（`ip4.c` 调） | `ethernet_output`（发送/广播/多播）或 `etharp_query` 入队后返回 |
| ARP 定时 | `etharp_tmr()`（每 1s） | 老化回收 `etharp_free_entry`；PENDING 重发；REREQUESTING 限速续期 |
| NDP 收包 | `nd6_input(p, inp)`（`icmp6.c:121` 调） | NA 应答：`nd6_send_na`；邻居状态推进 + `nd6_send_q` 出队 |
| NDP 发包 | `nd6_get_next_hop_addr_or_queue(netif, q, ip6addr, &hwaddr)`（`ethip6.c:108` 调） | `nd6_queue_packet` 入队（hwaddr=NULL）或返回 lladdr 由 `ethip6_output` 发 |
| NDP 定时 | `nd6_tmr()`（每 1s） | 状态推进、DAD 探测、路由器/前缀/目标缓存过期清理 |

## 未复制的依赖

本模块 `upstream/` 只保留上述文件；编译/运行时仍依赖以下上游文件，因与协议闭环正交（通用基础设施、平台适配、构建），不复制，仅在阅读时按需查看：

- **协议基础设施**：`lwip/opt.h`（全部 `LWIP_ND6_*`/`ARP_*` 配置宏与默认值）、`lwip/pbuf.h` + `core/pbuf.c`（报文缓冲）、`lwip/memp.h` + `core/memp.c`（`MEMP_ARP_QUEUE`/`MEMP_ND6_QUEUE` 队列池）、`lwip/ip_addr.h`/`ip4_addr.h`（地址）、`lwip/inet_chksum.h` + `core/inet_chksum.c`（IP/ICMP 校验）、`lwip/def.h`、`lwip/stats.h`（`ND6_STATS_*`/`ETHARP_STATS_*`）。
- **上层触发可达性提示**：`core/tcp_in.c` / `core/tcp_out.c`（`nd6_reachability_hint` 的调用者，TCP ACK 证据）。
- **与 DHCP/autoIP 的协作钩子**：`dhcp_arp_reply`、`autoip_arp_reply`、`dhcp6_nd6_ra_trigger`（见 `etharp.c:669-674`、`nd6.c:630-634`），本模块只记录其存在。
- **SNMP/MIB2**：`etharp.c` 中的 `mib2_add/remove_arp_entry`，仅影响管理面，不参与解析闭环。
- **平台/驱动**：`sys_arch.h`、各 `netif` 驱动（`linkoutput` 实现）、`arch/` 字节序与结构打包头（`PACK_STRUCT_*`）。本模块只依赖 `netif` 抽象与 `ethernet_output`/`ip6_output_if` 两个接口。
- **构建**：`Filelists.*`、CMake/Makefile、`test/unit/etharp/`（lwIP 自带 ARP 单测，可作行为参考）。