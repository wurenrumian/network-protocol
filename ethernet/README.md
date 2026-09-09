# Ethernet / 802.3 链路层

## 定位

本模块位于协议学习主干的最底层，负责回答「帧在一条链路上如何被寻址、封装与搬运」。它建立 MAC 地址、帧格式、MTU、类型/长度多义性这些贯穿全部上层协议的基础概念：IPv4/IPv6 报文、ARP 请求、ICMP 消息最终都以字节形式放进以太网帧的载荷里。

协议主干顺序中的位置（见 `protocol-learning-design.md` §4）：

```text
协议抽象与报文编码 → Ethernet / VLAN / bridge → ARP / NDP / DHCP → IPv4 / IPv6 / ICMP → ...
```

学习重点是 Ethernet II（DIX）帧格式、IEEE 802.3 对它的修订、EtherType 与长度字段的多义性、MAC 地址在网卡抽象（netif）中的角色，以及 MTU / checksum / TSO / GSO / GRO 这些会影响观察结果的机制。

## 前置模块

- **协议抽象与报文编码**：字节序（大端）、字段对齐、长度与边界、校验的一般模型。以太网帧的字节序、14 字节最小头部、尾部 CRC 都直接沿用这一套语言。

## 推荐阅读顺序

1. `protocol.md`：先建立问题与概念——以太网解决什么、不解决什么，帧在 wire 上的样子，MTU 与 TSO/GSO/GRO 为何会改变你观察到的现象。
2. `state-machine.md`：链路层没有显式状态机，以收发两条处理流程替代：收包 → 解析 → 分发，发包 → 封装 → 发送。
3. `src/README.md`：按「文件 → 类别 → 阅读范围」定位源码，沿调用链从入口到出口走一遍。
4. `references.md`：固定 IEEE 802.3、RFC 894 与 lwIP 版本，作为阅读时的对照。

阅读时建议同时打开 lwIP 的 `src/netif/ethernet.c` 与 `src/include/lwip/prot/ethernet.h`，对照 `protocol.md` 中的字段逐一落位；netif 抽象则在 `src/include/lwip/netif.h` 与 `src/core/netif.c`。

## 源码入口

复制到 `src/upstream/` 的上游文件见 `src/README.md`。核心入口：

- `src/include/lwip/prot/ethernet.h`：`struct eth_hdr` / `struct eth_addr` / `struct eth_vlan_hdr` 字段定义。
- `src/netif/ethernet.c`：`ethernet_input()`（收）与 `ethernet_output()`（发）两条主路径。
- `src/include/lwip/netif.h` + `src/core/netif.c`：`struct netif` 网卡抽象、`netif_input()` 分发入口。

## 主实现 / 对照实现

主实现为 **lwIP 2.1.3**（仓库 `lwIP-tcpip/lwip`，tag `STABLE-2_1_3_RELEASE`，commit `6ca936f6b588cee702c638eee75c2436e6cf75de`），负责帧格式与 netif 抽象。

对照实现：Linux 内核中 `net/ethernet/eth.c`（`eth_type_trans` 对类型/长度字段的分类）与 `net/core/dev.c` 中的 MTU/GSO/GRO 处理，以及 DPDK 的 `rte_ether`（`rte_ether_hdr`、`rte_ether_addr`）。控制面机制（VLAN/bridge/STP/LACP）主实现为 Open vSwitch，不在本模块。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。