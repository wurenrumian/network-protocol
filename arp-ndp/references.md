# ARP / IPv6 NDP · references

## 规范 / 标准

| RFC | 标题 | 与本模块的关系 |
| --- | --- | --- |
| [RFC 826](https://www.rfc-editor.org/rfc/rfc826) | Ethernet Address Resolution Protocol | ARP 本体：报文格式、"Packet Reception" 流程、泛化地址族设计。lwIP `etharp.c` 注释自称 compliant with RFC 826。 |
| [RFC 4861](https://www.rfc-editor.org/rfc/rfc4861) | Neighbor Discovery for IP version 6 (IPv6) | NDP 本体：NS/NA/RS/RA/RD 五种报文、邻居/目标/路由器/前缀四表、邻居状态机（§7.3）、NUD、重定向。lwIP `nd6_priv.h` 注释自称 compliant with RFC 4861。 |
| [RFC 4862](https://www.rfc-editor.org/rfc/rfc4862) | IPv6 Stateless Address Autoconfiguration | SLAAC + DAD：tentative 地址、`::` 源 NS 探测、NA 冲突应答、duplicate 地址状态。lwIP 在 `nd6.c`（`nd6_duplicate_addr_detected`、`nd6_process_autoconfig_prefix`）实现。 |
| [RFC 3220](https://www.rfc-editor.org/rfc/rfc3220) §4.6 | IP Mobility Support for IPv4 | Gratuitous ARP 的参考来源；lwIP 的 `etharp_gratuitous()` 注释即引用此节。 |
| [RFC 5227](https://www.rfc-editor.org/rfc/rfc5227) | IPv4 Address Conflict Detection | 现代版 gratuitous ARP / ACD 规范；对照 lwIP 的 DHCP 冲突检查（`dhcp_arp_reply`）。 |
| [RFC 4861 相关配套](https://www.rfc-editor.org/rfc/rfc5942) | IPv6 Addressing and Privacy Considerations（RFC 5942） | 静态地址 /64 隐含子网、自动配置地址 /128 语义——lwIP `nd6_is_prefix_in_netif` 注释引用。 |
| [RFC 4443](https://www.rfc-editor.org/rfc/rfc4443) | ICMPv6 | NDP 报文类型（133-137）与校验的宿主协议。 |
| IANA | [ARP 硬件类型 / EtherType](https://www.iana.org/assignments/arp-parameters/arp-parameters.xhtml) | hwtype=1、proto=0x0806/0x0800、ICMPv6 类型 135/136/133/134/137。 |

## 论文

- Plummer, D. — *"An Ethernet Address Resolution Protocol"*（RFC 826，1982 年 11 月）：ARP 的原始论文式规范，含"为什么需要地址解析"的动机与泛化设计。
- Narten, T., Nordmark, E., Simpson, W. — *"Neighbor Discovery for IP Version 6"*（RFC 4861，2007 年 9 月）：NDP 设计文档，§7.3 状态机与 §7.2 NUD 是对照实现的核心。
- Thomson, S., Narten, T. — *"IPv6 Stateless Address Autoconfiguration"*（RFC 4862，2007 年 9 月）：DAD 的算法与异常处理（5.4 节）。
- 补充阅读：*"IPv6 Address Conflict Detection"*（RFC 7527）与 *"Secure Neighbor Discovery"*（RFC 3971，SEND）——用于理解 NDP 未内置安全机制、及 SEcure Neighbor Discovery 的补强方向。

## 上游仓库（固定版本 / commit）

- **主实现：lwIP**
  - 仓库：`github.com/lwIP-tcpip/lwip`
  - 固定版本：**STABLE-2_1_3_RELEASE**（2021-11-10）
  - 固定 commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
  - 本模块使用文件（保留上游相对路径）：
    - `src/core/ipv4/etharp.c`（ARP 表、请求/应答、缓存、老化、重请求）
    - `src/include/lwip/etharp.h`（ARP 对外 API 与表项队列结构）
    - `src/include/lwip/prot/etharp.h`（ARP 报文 `struct etharp_hdr`、opcode）
    - `src/core/ipv6/nd6.c`（NDP 全部逻辑）
    - `src/include/lwip/nd6.h`（NDP 对外 API）
    - `src/include/lwip/priv/nd6_priv.h`（邻居/目标/路由器/前缀表结构与状态枚举）
    - `src/include/lwip/prot/nd6.h`（NS/NA/RS/RA/RD 报文头与 option 定义）
    - `src/include/lwip/prot/icmp6.h`（ICMPv6 类型枚举 133-137）
    - `src/core/ipv6/icmp6.c`（ICMPv6 分发 → `nd6_input`）
    - `src/core/ipv6/ethip6.c`（Ethernet 网卡的 `output_ip6` → `nd6_get_next_hop_addr_or_queue`）
    - `src/netif/ethernet.c`（以太网帧分发 → `etharp_input` / `ip6_input`）
    - `src/core/ipv4/ip4.c`（`ip4_output` → `etharp_output`）
    - `src/core/ipv6/ip6.c`（`ip6_input` → `icmp6_input`、`ip6_output_if_src` → `netif->output_ip6`）
    - `src/include/lwip/netif.h`（`struct netif` 与 `output_ip6` 函数指针）
    - `src/include/lwip/ip6_addr.h`（IP6_ADDR_* 地址状态位）
  - 许可证：BSD-3-Clause（`COPYING`），复制时保留原版权头；学习注释只加不改。

## 其他实现

- **Linux 内核**（对照，不复制进 `src/`，阅读时按源码在线查看）：
  - ARP：`net/ipv4/arp.c`、`net/ipv4/arp.c`（`arp_rcv`、`__neigh_lookup`、`neigh_table`）。注意 Linux 的 ARP 即 `neigh` 模块；`ip neigh` 命令暴露其表。
  - NDP：`net/ipv6/ndisc.c`（`ndisc_rcv`、`ndisc_solicit`、`neigh_*` 状态，Linux 用 `nud_state` 字段实现 RFC 4861 状态机）。
  - 对比点：Linux 使用哈希表 + 动态 `neigh` 条目 vs lwIP 固定数组；Linux 对每邻居有独立超时定时器 vs lwIP 单一 `nd6_tmr` 轮询；Linux 的 `ARP` 与 `ND` 表容量与回收策略差异。
- **IPv6 其它用户态实现**（用于交叉验证报文与状态语义）：
  - `tcpdump`/Wireshark 的 ND 解析（`packet-icmpv6.c`）——验证 NS/NA/RA option 编码。
  - 嵌入式协议栈对照：FreeRTOS lwIP 分支（与上游行为一致）、`uIP`（无 NDP）。
- **SEND 扩展**（了解 NDP 安全演进方向）：RFC 3971（Secure Neighbor Discovery），CGA 地址。

## 阅读备注

- **版本锁定**：所有 `src/` 文件来自 lwIP 2.1.3 的 `STABLE-2_1_3_RELEASE` tag（commit `6ca936f…`）。上游 2.1.3 之后的结构（如 `src/netif/etharp.c` 的旧路径）与本版本不同，本模块以"tag 内实际路径"为准——即 ARP 实现位于 `src/core/ipv4/etharp.c`，`src/include/netif/etharp.h` 仅为兼容 shim。
- **阅读顺序建议**：先 `protocol.md` → `state-machine.md` → 按 `src/README.md` 的"读序"读 core/ 两个闭环 → 再补 integration/ 的 `ethernet.c` 与 `icmp6.c` 入口分发 → 最后用 `ip6.c`/`netif.h` 的出口函数指针理解 `ethip6_output` 挂接。
- **对照工具**：用 `ip neigh show`（Linux）观察邻居状态；用 `tcpdump -i eth0 arp` 与 `tcpdump -i eth0 'icmp6 && (ip6[40] == 135 || ip6[40] == 136)'` 抓 NS/NA；把抓包与 `nd6_input` 的校验分支对应（Hop Limit=255 检查）。
- **常见坑**：NDP 报文的 Hop Limit 必须为 255（跨路由器即失效）；NA 的 S 位只在应答单播 NS 时置；DAD 的 NS 源地址必须是 `::` 且不带 Source LLADDR option；RA 的 option 长度单位为 8 字节（`length << 3`）。
- **与 IPv4/IPv6 模块的关系**：本模块只负责"下一跳 MAC"，不涉及全局路由；`nd6_get_next_hop_entry` 中的目标缓存与路由器选择逻辑将并入 ipv4-ipv6/路由模块继续深入。
- **补丁记录**：当前未对上游源码做任何功能修改；若后续在学习注释中发现明显错误并修正，将在此节追加补丁说明，不改变上游控制流与命名。