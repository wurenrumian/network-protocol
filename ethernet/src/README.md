# Ethernet / 802.3 链路层 · src

## 上游版本

- 仓库：`https://github.com/lwIP-tcpip/lwip`
- 版本：**lwIP 2.1.3**
- tag：`STABLE-2_1_3_RELEASE`
- commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：BSD-2-Clause，`src/LICENSES/COPYING`（来自上游根目录 `COPYING`，为 2.1.3 release 的实际文件）

## 文件清单（文件 → 类别 → 阅读范围）

类别：`core/` = 协议本身（报文、状态机、定时器、队列）；`integration/` = 与 socket、TLS、事件循环或其他协议的连接；`platform/` = 网卡、系统调用、线程/锁、操作系统适配。

| 文件（`src/upstream/` 下相对路径） | 原始路径 | 类别 | 阅读范围 |
| --- | --- | --- | --- |
| `src/include/lwip/prot/ethernet.h` | `src/include/lwip/prot/ethernet.h` | core | `struct eth_addr`、`struct eth_hdr`、`struct eth_vlan_hdr`、`SIZEOF_ETH_HDR`；PACK_STRUCT 宏仅为移植便利，可跳过 |
| `src/netif/ethernet.c` | `src/netif/ethernet.c` | core | `ethernet_input`、`ethernet_output` 两个完整函数；PPPoE/`LWIP_HOOK_*` 分支可跳过 |
| `src/include/lwip/netif.h` | `src/include/lwip/netif.h` | core | `struct netif` 字段与 `netif_*_fn` 函数类型；`netif_ext_callback` 扩展回调可跳过 |
| `src/core/netif.c` | `src/core/netif.c` | core | `netif_input`、`netif_add`、`netif_set_up/down`、`netif_set_link_up/down`、`netif_loop_output`、`netif_poll_all`；地址变更/IGMP 上报分支按需略读 |
| `src/include/lwip/ethip6.h` | `src/include/lwip/ethip6.h` | integration | `ethip6_output()`（IPv6→以太网输出的真实调用者，链路层出口的 integration 侧） |

## 阅读顺序与调用链

**收包闭环**（推荐先读）：

```text
netif_input(p, netif)                      netif.c
→ ethernet_input(p, netif)                 ethernet.c：长度检查 → 读 EtherType → switch
→ pbuf_header() 剥头（指针移动，零拷贝）
→ ip4_input / ip6_input / etharp_input     [上层分发，本模块只到入口]
```

**发包闭环**（其次读）：

```text
ip4_output / ip6_output 确定下一跳 MAC
→ ethip6_output（IPv6） / IPv4 输出路径     ethip6.h（integration）
→ ethernet_output(netif, p, ip4, ip6)      ethernet.c：预留 14B → 写 dest/src/type
→ netif->linkoutput(netif, p)              [platform 驱动，硬件加 FCS]
```

**netif 生命周期**（支撑性阅读）：

```text
netif_init / netif_add → netif_set_up/down → netif_remove
netif_poll_all → netif_poll → 各驱动轮询入口
```

## 入口函数 / 结束函数

| 路径 | 入口 | 结束 |
| --- | --- | --- |
| 收包 | `netif_input()` → `ethernet_input()` | 交给 `ip4_input`/`ip6_input`/`etharp_input`（本模块的边界）；错误路径以 `pbuf_free()` 结束 |
| 发包 | `ethernet_output()` | `netif->linkoutput(netif, p)`（平台边界）；错误路径直接返回错误值，不发送 |
| 生命周期 | `netif_add()` | `netif_remove()` |

## 未复制的依赖

以下文件为编译/移植所需，但不在本闭环内，按 §3 规范未复制：

- `src/include/lwip/def.h`、`src/include/lwip/opt.h`：类型定义、字节序宏与编译开关（`lwip_htons`、`LWIP_IPV4` 等）所在。
- `src/include/lwip/pbuf.h` 与 `src/core/pbuf.c`：`pbuf_header`、`pbuf_free` 等缓冲区操作实现。
- `src/include/lwip/ip4.h`、`src/include/lwip/ip6.h`、`src/include/lwip/etharp.h` 与对应 `ip4.c`、`ip6.c`、`etharp.c`：分发目标（上层入口）的完整实现，属于 ARP/IP 模块。
- `src/include/lwip/arch/`（`bpstruct.h`/`epstruct.h`）与字节序 PACK_STRUCT 宏：仅影响结构布局的移植层。
- `src/netif/pppoe.c` 及 PPP 相关：`ethernet.c` 中 `PPPOE_SUPPORT` 分支的依赖，本模块不展开。

## 已复制 / 跳过说明

- **已复制（6 个文件）**：任务要求的 5 个源码文件按原始相对路径放入 `src/upstream/`；`COPYING` 放入 `src/LICENSES/`。
- **跳过**：上述「未复制的依赖」文件均未复制；本模块编译所需的整体 lwIP 工程未带入，也不要求在本仓库编译运行（见 `protocol-learning-design.md` §2「源码为主」）。
- **完整性**：5 个上游文件均以 tag `STABLE-2_1_3_RELEASE` 的实际内容原样保存，未做裁剪或改写；学习注释（若添加）只写在副本上，不改变上游控制流与命名。
- **注意**：`netif.h`/`netif.c` 中 `netif_poll`/`netif_loopif` 等平台相关分支保留完整文件，但不在本闭环阅读范围。