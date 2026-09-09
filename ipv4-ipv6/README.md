# IPv4 / IPv6

## 定位

本模块覆盖网络层的两个版本：IPv4（RFC 791）与 IPv6（RFC 8200）。在协议学习主干中位于链路层（Ethernet / VLAN / bridge）与邻居层（ARP / NDP / DHCP）之上、ICMP / 传输层（UDP / TCP）之下，见根目录 `protocol-learning-design.md` §4.3。

IPv4/IPv6 解决的核心问题是：**在异构以太网链路上提供全局寻址、跨链路转发、节点可达判定与载荷上抛**。它把链路层的 MAC 寻址抽象为统一的网络层地址，屏蔽不同链路的差异，并限定每次传输的载荷上界（MTU），让上层只需要面对「目标地址 + 载荷长度」两个事实。

与链路层、传输层相比，网络层的重心不是时顺序回复答，而是：

- 地址的**编址与子网划分**（IPv4 可变子网 / IPv6 固定前缀）；
- **逐跳转发**的决策与下一跳解析（交给 ARP/NDP，本模块只负责出接口与下一跳 IP）；
- **包过大**（MTU / PMTU）时的**分片、重组与丢弃**，用 ICMP 反馈黑洞；
- **TTL / Hop Limit** 的防环机制与错误的**丢弃**上报；
- 上层协议的**分发**（IPv4 Protocol 字段 / IPv6 Next Header 链）与逐跳可选的校验。

## 前置模块

- **Ethernet / VLAN / bridge**：理解 IP 载荷如何被封装进 L2 帧、MTU 的来源与 CSMA 边界，见链路层模块。
- **协议抽象与编码**：字节序（网络字节序）、长度/边界与校验的通用语言，见 `<protocol-abstract>` 模块。
- 传输层模块（UDP/TCP）可直接对照阅读：校验和覆盖范围、端口复用等，在复核时使用。

## 推荐阅读顺序

按「先读 wire format 与协议语义，再读主实现闭环」的方式推进，分为三组：

1. **规范 / 报文**
   1. RFC 791（IPv4 头与分片）、RFC 8200（IPv6 头与扩展头）、RFC 8201（PMTU）；
   2. `<protocol-abstract>` 中关于大端、校验和的分布总结；
   3. `references.md` 中列出的其他实现对比点。
2. **源码结构（src/README.md）**
   - `prot/ip.h` `prot/ip4.h` `prot/ip6.h`：**wire format 的结构体定义**，与 RFC 字段逐列对应；
   - `ip4_addr.c` / `ip6_addr.c`：地址的表示、比较、掩码与 netmask 运算；
   - `ip4.c`：IPv4 收包的 `ip_input`（校验、分片重组、分发）与 `ip_output`（选路、分片、发送前 poste）；
   - `ip6.c`：IPv6 收发的对应实现，重点观察极高优先级的 `ip6_frag`（IPv6 只在源处分片，不带 Broadcast 和 DF）与 Next Header 的扩展头遍历。
3. **机制闭环**：沿 §4.3 前序链路层模块往上，通过断线、错误包、超大包三个真实场景把上述函数串起来：
   - 收包：`netif`（L2 上抛）→ `ip_input / ip6_input` → 头校验 / 分片重组 → `ip4_route` 语义判断 → 协议分发（`icmp`、`udp`、`tcp`、`igmp / icmp6` 等）；
   - 发包：应用上层 → `ip4_route`/选路 → `ip4_output` → `ip4_frag`（分片）→ `netif->output`（L2 下发）。

## 源码入口

进入读源码前，先读 `src/README.md`（文件清单、阅读顺序、调用链、入口函数）。

- 核心入口/出口：
  - **收包分发**：`src/core/ipv4/ip4.c` 中 `ip4_input`（对 IHL>最小头的包做选项拒绝检查），IPv6 对应 `src/core/ipv6/ip6.c` 的 `ip6_input`（及扩展头解析）。
  - **发送主路径**：`ip4.c` 的 `ip4_output / ip4_output_if / ip4_output_if_src` 与 `ip4_frag`；IPv6 对应 `ip6_output / ip6_output_if / ip6_frag`。
  - **地址对象**：`ip4_addr.c` 的 `ip4_addr` 相关函数，`ip6_addr.c` 的 `ip6_addr` 相关函数。
- Wire 驱动：`src/include/lwip/prot/ip.h`、`ip4.h`、`ip6.h` 中的结构体（`struct ip_hdr`、`struct ip6_hdr`、`struct ip6_frag_hdr` 等）。

## 主实现 / 对照实现

- **主实现**：lwIP 2.1.3（本模块固定版本与 commit 见 `references.md` §上游仓库）。
- **对照实现**（选读，不入 `src/`）：Linux 内核的 IPv4/IPv6 网络层（`net/ipv4`、`net/ipv6`），用于对比「无分片处理」策略、扩展头（「Reading over extension headers」一节的简化选型）、以及内核在异步、锁、内存复制上的差异；Zephyr / FreeRTOS TCP/IP 栈与 lwIP 同族，主要用于函数关系比较。

## 目录规范

参见根目录 `protocol-learning-design.md` §3（文件职责、注释规范、源码选择与注释、许可证复制）。