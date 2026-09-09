# IPv4 / IPv6 · src

## 上游版本

- 仓库：`https://github.com/lwIP-tcpip/lwip`
- tag：`STABLE-2_1_3_RELEASE`；commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：BSD-3-Clause，见 `src/LICENSES/COPYING`（复制于上游仓库根目录 `COPYING`）。

## 文件清单（文件 → 类别 → 阅读范围）

以下文件已拷贝入 `src/upstream/`（保留上游相对路径）。

| 文件（`src/upstream/` 内路径） | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/include/lwip/prot/ip.h` | core | 共同结构：`IP_PROTO_*` 常量与 `IP_HDR_GET_VERSION` 宏；地址联合体在 `lwip/ip_addr.h`。 |
| `src/include/lwip/prot/ip4.h` | core | **完整**：`struct ip_hdr`、`IPH_*` 宏与 `IP_PROTO_*` 定义。 |
| `src/include/lwip/prot/ip6.h` | core | **完整**：`struct ip6_hdr`、`struct ip6_frag_hdr`、`IP6H_*` 宏。 |
| `src/core/ipv4/ip4_addr.c` | core | **完整**：地址表示、掩码、网段比较、广播判定、netmask 有效性。 |
| `src/core/ipv4/ip4.c` | core | **完整**：`ip4_input`/`ip4_output` 主收/发路径、`ip4_route`/`ip4_forward`、选项解析。 |
| `src/core/ipv6/ip6_addr.c` | core | **完整**：`ip6addr_aton`/`ip6addr_ntoa(_r)` 文本解析与表示（343 行）；前缀比较/组播判断等宏与内联函数在 `lwip/ip6_addr.h`。 |
| `src/core/ipv6/ip6.c` | core | **完整**：`ip6_input`/`ip6_output` 主收/发路径、扩展头遍历、源地址选择。 |

类别说明：以上均为 `core/`（协议本身）。`integration/`（与上层 socket/TLS 的衔接）与 `platform/`（netif 驱动、OS 适配）不在本模块裁剪，未复制，见「未复制的依赖」。

## 阅读顺序与调用链

### 收包链（核心）

```
netif（链路层上抛 netif->input）
→ ip4_input            (src/core/ipv4/ip4.c)  校验、选项、分片判断
    ├─ 本机/Broadcast/组播接受 → dispatch（按 Protocol 字段）
    └─ 非本机且转发开启 → ip4_canforward → ip4_forward
       → ip4_route … → netif->output（转出）

ip6_input               (src/core/ipv6/ip6.c)
├─ 校验版本、长度 → 遍历 Next Header（仅支持分片扩展头）
│    → 分片 → 归组 →「收集/收齐/超时」→ 重组完成后回 ip6_input 继续
└─ 最终 → dispatch（icmp6/udp/tcp）
```

### 发线链（核心）

```
上层调用 ip4_output / ip6_output
→ ip4_route / ip4_route_src（IPv6: ip6_route / ip6_select_source_address）
→ ip4_output_if_src / ip6_output_if_src
     ├─ 长度 ≤ MTU → 填头（TTL/HopLimit、Protocol/NextHeader、校验和）
     └─ 长度 > MTU
         ├─ IPv4：IP_FRAG? → ip4_frag（注意 ip4_frag 定义在 ip4_frag.c，未复制）
         └─ IPv6：存在且允许 → ip6_frag（源端分片，ip6_frag.c，未复制）
→ netif->output（调用链路层发送）
```

（IPv4 头校验：`inet_chksum(iphdr, iphdr_hlen)`，`ip4.c:497` 附近；IPv6 无头校验。）

## 入口函数 / 结束函数

| 函数 | 文件 | 角色 |
| --- | --- | --- |
| `ip4_input(struct pbuf*, struct netif*)` | `src/core/ipv4/ip4.c` | IPv4 收包入口 |
| `ip4_output*`（`ip4_output`/`ip4_output_if`/`ip4_output_if_src`/`ip4_output_if_opt_src`） | `src/core/ipv4/ip4.c` | IPv4 发包入口族 |
| `ip4_route`/`ip4_route_src` | `src/core/ipv4/ip4.c` | 选路 |
| `ip4_canforward`/`ip4_forward` | `src/core/ipv4/ip4.c` | 转发判断与执行 |
| `ip6_input(struct pbuf*, struct netif*)` | `src/core/ipv6/ip6.c` | IPv6 收包入口 |
| `ip6_output_if_src`/`ip6_output` | `src/core/ipv6/ip6.c` | IPv6 发包入口族 |
| `ip6_route`/`ip6_select_source_address` | `src/core/ipv6/ip6.c` | 选路/源地址选择 |

出口统一都是 `netif->output`（IPv4）/ `netif->output_ip6`（IPv6，链路层驱动，linkoutput 在驱动内由 output 包装）；收包链的结束时函数是上层协议分发（`icmp_input`、`udp_input`、`tcp_input`、`igmp_input` / `icmp6_input` 等），它们不在本模块复制的文件内（见下）。

## 未复制的依赖

下述符号在已复制文件中被引用，但因与协议正文（报文字段与主路径）无直接关系或位于协议外，不纳入本模块 `src/upstream/`，阅读调用链时可查阅 lwIP 仓库对应文件：

- **路由/接口抽象**：`lwip/netif.h`（`struct netif`、`netif->output`/`output_ip6`/`linkoutput`、`netif->input`）——netif 是本模块承载网卡 MTU 与上抛的核心抽象，属于 `platform/` 边界，见上游 `src/core/netif.c`、`src/include/lwip/netif.h`。
- **分片实现**：`lwip/ip4_frag.h` 与 `src/core/ipv4/ip4_frag.c`（`ip4_frag` 发送侧分片、`ip4_reass` 收包重组）、`lwip/ip6_frag.h` 与 `src/core/ipv6/ip6_frag.c`（`ip6_frag` 源端分片、`ip6_reass` 收包重组）——收包重组由 `ip4_input`/`ip6_input` 内联调用，发送分片则在长度超 MTU 时调用；若需完整追踪分片，补充复制这四个文件。
- **地址类型与宏**：`lwip/ip_addr.h`（`ip_addr_t`/`ip_addr_packed` 联合体、`ip_2_ip4`/`ip_2_ip6` 转换）与 `lwip/ip6_addr.h`（`ip6_addr_t`、`ip6_addr_netcmp` 前缀比较、`ip6_addr_ismulticast` 等宏与内联函数）——被 `ip4.c`/`ip6.c`/`ip6_addr.c` 重度引用，未复制。
- **校验和工具**：`lwip/inet_chksum.h` 与 `src/core/inet_chksum.c`（`inet_chksum`、`inet_chksum_pseudo`）；IPv6 头不校验但它仍被上层伪头使用。
- **ICMP/ICMPv6**：`src/core/ipv4/icmp.c`、`src/core/ipv6/icmp6.c`（TTL 过期、Fragmentation Needed、Packet Too Big 的回报），若想观察「丢弃后回报」这一分支，可参考。
- **pbuf / 内存**：`lwip/pbuf.h` 与 `src/core/pbuf.c`（报文内存与链式 buffer，`struct pbuf` 贯穿收发链）。
- **系统/宏（lwipopt.h、lwip.h、debug.h）**：编译性配置，不阅读。

## 已复制 / 跳过说明

- 已复制 7 份源文件 + 1 份许可证（共 8 项），均为 lwIP `STABLE-2_1_3_RELEASE` 原文件，未改内容；只允许在后文中添加 `[RFC]/[STATE]/[INVARIANT]` 学习注释（见设计文档 §3）。
- 未出现的路径（如 `src/core/ipv4/ip4_frag.c`、`ip6_frag.c`、`lwip/ip_addr.h`、`lwip/ip6_addr.h`）属于**未复制**而非丢失；若要追踪分片或地址宏，按上面补充。
- 若后续发现某个函数被反复引用但不在以上清单中，先检查「未复制的依赖」，避免误以为文件缺失。