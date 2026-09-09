# DHCP

## 定位

本模块对应学习主干中「邻居、网络层与路由」（§4.3）的 **DHCP** 一节，紧接 ARP / IPv6 NDP 之后，属于 IPv4 / IPv6 网络层的前置配置机制。

核心问题：主机接入网络后，如何**自动获得**可用的 IP 地址、子网掩码、网关、DNS 等参数，并在地址租约过期前自动续租。DHCP 不解决地址的分层路由（那是 IP 模块的事），也不参与报文的逐跳转发（那是 ARP 的事）；它只解决「上线之前」的配置获取，以及「上线期间」的租约维护。

阅读本模块应能回答：

- 为什么 DHCP 继承 BOOTP 的固定报文结构，而不是从头设计 TLV 报文；
- DORA 四次交互如何把「地址可用性」的判断从服务器转移到客户端；
- T1/T2/租期三个定时器如何把「单次配置」变成「生命周期维护」；
- 客户端状态机（INIT → SELECTING → REQUESTING → BOUND → RENEWING/REBINDING）如何在无状态 UDP 上获得可靠性；
- DHCPv4 与 DHCPv6 在报文、端口、地址协商模型上的本质差异。

## 前置模块

按依赖顺序：

1. **协议抽象与编码**：报文布局、字节序、TLV、版本/扩展、超时与重试的分析语言。
2. **Ethernet**：DHCP 的 DISCOVER/REQUEST 依赖广播，理解链路层广播与帧过滤是前提。
3. **ARP / IPv6 NDP**：DHCP 通过 ARP（可选）探测地址冲突，且与自动配置（IPv4LL/APIPA）协作；IPv6 无状态地址配置（SLAAC）是理解 DHCPv6 有状态/无状态划分的参照系。
4. **IPv4 / IPv6**：DHCP 分配的是 IP 地址，报文由 UDP 承载；理解 IP 地址、广播地址、组播地址（DHCPv6 用 FF02::1:2）才能读通收发路径。
5. **UDP**：DHCP 是典型的上层为「UDP + 定时器」而构建的可靠性的例子（与 TCP 的可靠窗口对照）。
6. 对照参考 **DNS**：二者都是「UDP + 重传 + 缓存 + 少量状态」的客户端协议，可横向比较超时策略。

## 推荐阅读顺序

1. `protocol.md` —— 问题定义、租约/option 抽象、wire format、DORA 与续租机制、DHCPv6 差异。**先读规范再读源码。**
2. `state-machine.md` —— 以客户端状态机为主线，标注事件、超时与异常时序。
3. `references.md` —— 固定 RFC 2131/2132/3315 与 lwIP 2.1.3（commit `6ca936f`）。
4. `src/README.md` —— 文件清单与调用链导航。
5. 进入 `src/upstream/`，按 §4.0 的 core → integration 顺序阅读：
   - core：`src/core/ipv4/dhcp.c`、`src/core/ipv6/dhcp6.c`、`src/include/lwip/prot/dhcp.h`、`src/include/lwip/prot/dhcp6.h`
   - integration：`src/core/ipv4/etharp.c`（ARP 冲突探测）、`src/core/dns.c`（option 交付到 DNS）
   - platform：`src/core/udp.c`、`src/core/netif.c`（PCB 与 client-data 挂载）

## 源码入口

- 入口：`dhcp_start(netif)`（`src/core/ipv4/dhcp.c:742`）—— 见 `src/README.md` 调用链。
- 状态机核心：`dhcp_handle_offer` / `dhcp_select` / `dhcp_handle_ack` / `dhcp_bind` / `dhcp_timeout` / `dhcp_t1_timeout` / `dhcp_t2_timeout`。
- 报文收发：`dhcp_create_msg`（构造）与 `dhcp_recv`（解析、校验、分发）。
- 定时器：`dhcp_fine_tmr`（500ms，请求重试）与 `dhcp_coarse_tmr`（60s，租约/T1/T2）。
- DHCPv6：`dhcp6_enable_stateless`、`dhcp6_information_request`、`dhcp6_recv`。

## 主实现 / 对照实现

- **主实现（客户端）**：lwIP `src/core/ipv4/dhcp.c` 与 `src/core/ipv6/dhcp6.c`，固定版本 2.1.3（见 `references.md`）。选 lwIP 的原因：DHCP 客户端状态机完整、可独立追踪、报文与选项结构集中在一个小头文件中，且与 ARP/UDP/netif 的集成边界清晰。
- **对照实现（服务器端）**：ISC DHCP（kea，`server/dhcpd.c`）与 dnsmasq（`src/dhcp.c`）。客户端视角无法覆盖服务器侧的「地址池管理、冲突检测、租约数据库」，需要这两个实现补充。不复制其源码，只在 `references.md` 记录仓库与阅读要点。

## 目录规范

参见根目录 `protocol-learning-design.md` §3。