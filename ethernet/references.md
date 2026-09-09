# Ethernet / 802.3 链路层 · references

## 规范 / 标准

- **IEEE 802.3**（IEEE Std 802.3-2018 及后续修订）：以太网物理层与 MAC 层标准，定义帧格式、最小/最大帧长、FCS（CRC-32）、前导/定界符、碰撞检测与退避。EtherType 字段在 802.3 中被重新解释为长度字段，形成与 Ethernet II（DIX）的兼容问题。
- **RFC 894**：在 IP over Ethernet 网络中传输 IP 数据报——定义 IPv4 封装在 Ethernet II 帧中的 MTU（1500）与推荐用法。
- **RFC 1042**：IP over IEEE 802 网络的封装——802.3 帧经 LLC/SNAP 承载 IP 的替代封装（lwIP 主路径不采用）。
- **IEEE 802.1Q**（VLAN 标签）：TPID 0x8100、TCI 中优先级/DEI/VID 字段，`ethernet.h` 中 `eth_vlan_hdr` 的协议依据。

## 论文

- R. Metcalfe & D. Boggs, **Ethernet: Distributed Packet Switching for Local Computer Networks**（1976 年原创论文，CACM）——以太网起源与设计动机。

## 上游仓库（固定版本 / commit）

- 仓库：`https://github.com/lwIP-tcpip/lwip`
- 版本：**2.1.3**（tag `STABLE-2_1_3_RELEASE`）
- commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：BSD-2-Clause（`COPYING`，已复制到 `src/LICENSES/`）

相关文件原始路径：

```text
src/include/lwip/prot/ethernet.h
src/netif/ethernet.c
src/include/lwip/netif.h
src/core/netif.c
src/include/lwip/ethip6.h
COPYING
```

## 其他实现

| 实现 | 关注点 | 对比角度 |
| --- | --- | --- |
| Linux 内核 `net/ethernet/eth.c`（`eth_type_trans`）、`net/core/dev.c` | 类型/长度多义性判别、MTU、GSO/GRO 钩子 | 与 lwIP 只按 EtherType 分发对比；看 GSO/GRO 如何落在网络层而非协议栈 |
| Linux 网卡驱动 + 固件 | TSO、FCS 硬件计算、巨型帧 | 「看到的帧 ≠ 应用写出的字节」的根源 |
| DPDK `rte_ether`（`rte_ether_hdr` / `rte_ether_addr`） | 用户态收发的帧结构 | 与 lwIP 对比零拷贝与批量收发的处理 |
| Open vSwitch | VLAN/bridge/STP/LACP 控制面（§4.2 选型） | 本模块不展开，链路层控制面见对应模块 |

## 阅读备注

- 阅读时**不要逐行核对行号**：lwIP 源码随版本演进，行号会漂移；用函数名定位。
- 把 `ethernet.c` 的收/发两个函数当作闭环主线，netif 抽象只读支撑结论的部分（`netif.c` 中 `netif_add`、`netif_input`、`netif_set_up/down`、`netif_loop_output` 附近）。
- TSO/GSO/GRO 不在 lwIP 中实现，理解它们必须回到 Linux 网络层与网卡驱动（对照实现），否则抓包现象无法解释。
- `ethip6.h` 的 `ethip6_output()` 是 IPv6→以太网输出在链路层的真实调用者，阅读发包路径时应包含它（注意：lwIP 的 IPv6 以太网输出与 IPv4 共用 `ethernet_output`，区别在目的 MAC 的来源）。
- 注释遵循项目规范：不改变上游控制流与命名，仅在复制副本上添加 `[RFC]/[STATE]/[INVARIANT]/[BOUNDARY]` 语义注释；确需修正错误时另加补丁文件并在此说明。