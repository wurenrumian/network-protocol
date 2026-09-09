# Ethernet / 802.3 链路层 · protocol

## 问题定义

以太网解决的问题：**在同一物理链路上，多个节点如何把可变长的数据单元可靠地送达指定的一个（或多个）邻居**。

它明确不负责：

- 端到端寻址与路由（那是 IP 的工作）；
- 跨网段转发（那是 bridge/router 的工作）；
- 链路层之上的可靠传输（TCP/UDP 负责）；
- 拥塞控制、分片重组之上的语义（IP 负责分片，链路层只关心单帧大小是否超出 MTU）。

链路层只承诺「一个帧、一条链路、一跳」。边界条件全部由物理介质、帧长限制（最小/最大）和单条链路的寻址决定。

## 抽象对象

| 对象 | 含义 | 关键属性 |
| --- | --- | --- |
| MAC 地址 `eth_addr` | 网卡在链路层的标识（6 字节） | 全零 = 未配置；低位第 1 位 = 单播/组播；全 FF = 广播 |
| 帧（frame） | 链路层的传输单元 | 头部 14 字节 + 载荷 + 尾部 FCS |
| EtherType | 载荷协议标识 | 网络字节序（大端）u16 |
| 网卡抽象 `netif` | 协议栈对一块接口的封装 | hwaddr、mtu、up/down 状态、input/output 函数指针 |
| pbuf | lwIP 中承载报文的缓冲区链 | 支持链式、引用计数、header 移动 |

## wire format

### Ethernet II（DIX）帧

```text
 0                   7                   15                  23
+---+---+---+---+---+---+---+---+---+---+---+---+---+---+
|  dest MAC (6)     |  src MAC (6)      |  EtherType (2) |
+---+---+---+---+---+---+---+---+---+---+---+---+---+---+
|  payload (46..1500 字节)                  |  FCS (4)     |
+--------------------------------------------+------------+
```

- 字段均按大端（网络字节序）发送：目的 MAC 的字节 0 最先到线上，EtherType 高字节在前。
- 目的/源 MAC 各 6 字节，源 MAC 全零帧通常被网卡丢弃（不变量：合法帧 src ≠ 00:00:00:00:00:00）。
- 帧间间隔（IFG）12 字节、前导/定界符在物理层添加，不进入协议数据。
- 最小帧长 64 字节（含 FCS）：以太网帧载荷若不足 46 字节，由上层（IP 会自行补齐）或填充保证；lwIP 的 `LWIP_SUPPORT_CUSTOM_PBUF` 与输出路径会在必要时填充。lwIP 主要工作在 Ethernet II（EtherType ≥ 0x0600），不处理 802.3 长度字段语义（见设计取舍）。
- 最大帧长 1518 字节（FCS 计入 1522），对应 MTU 1500。

### 类型/长度多义性（EtherType vs 802.3 Length）

- 字段值 ≥ 0x0600（1536）时解释为 **EtherType**（Ethernet II / DIX 惯例）；
- 字段值 ≤ 0x05DC（1500）时解释为 **长度**（IEEE 802.3 惯例），随后按 802.3 帧处理：隐含 8 字节 LLC/SNAP 头部（DSAP/SSAP/Control + 5 字节 SNAP 内含实际 EtherType）。

lwIP 的 `ethernet_input()` 只做 `switch (ethhdr->type)` 分发，期望收到的是 EtherType 值；若收到 802.3 长度编码的帧，会因为不匹配任何已知 EtherType 而落入未知协议分支被丢弃（`ETHARP_STATS_INC(etharp.proterr)` + `etharp.drop`）。

### EtherType 常见取值（对照实现 `eth_type_trans` 的分类）

| 值 | 含义 |
| --- | --- |
| 0x0800 | IPv4 |
| 0x86DD | IPv6 |
| 0x0806 | ARP |
| 0x8035 | RARP |
| 0x8100 | 在多种实现中用于 VLAN 探测（非标准） |
| 0x8847 | MPLS 单播 |
| 0x8863 / 0x8864 | PPPoE Discovery / Session |
| 0x88CC | LLDP |
| ≥ 0x0600 | 通常按 EtherType 处理；低于此值按长度（802.3） |

### VLAN 预留（802.1Q）

VLAN 标签在帧头之后、载荷之前插入 4 字节：TPID 0x8100（或 0x88A8）＋ TCI（2 字节优先级/DEI/VID）。`ETH_PAD_SIZE` 与 `eth_vlan_hdr` 在 `ethernet.h` 中预留了这种布局：`ETHARP_SUPPORT_VLAN` 编译开关允许 `ethernet_input()` 在收到 0x8100 时剥掉 VLAN 头再分发。本模块只在协议层面记录该预留，不展开 802.1Q 桥语义（那属于 Open vSwitch 模块）。

### MTU

- IP 层面的 MTU 是指**不含以太网头部/FCS**的最大载荷字节数（经典 1500）。
- 观察到的「帧长度」因工具而异：Wireshark 默认帧长度含 14 字节头部；tcpdump 的 `len` 通常不含 FCS，但含头部与载荷。
- 协议栈软件通常把 1500 硬编码为常见 netif 的 MTU，真正的介质 MTU（巨型帧等）由驱动上报；lwIP 的 netif 持有 `mtu` 字段，IPv4 在分片决策、IPv6 在 PMTU 计算时读取它。

## 核心机制

### 收包路径（ethernet_input）

1. 驱动/OS 收到一个帧并交给 `netif_input()`，后者校验 `p->len >= SIZEOF_ETH_HDR` 后调用注册的 `netif->input`。
2. `ethernet_input(p, netif)`：
   - 检查帧长：不足 14 字节 → `pbuf_free()` 丢弃。
   - 读取 `ethhdr->type`，`lwip_htons()` 转为主机序后 `switch` 分发：
     - `ETHTYPE_VLAN`（若 `ETHARP_SUPPORT_VLAN`）：检查/剥掉 VLAN 头，递归分发。
     - `ETHTYPE_IPV6`：`pbuf_header(p, -(s16)sizeof(struct eth_hdr))` 剥掉以太网头后交给 `ip6_input(p, netif)`。
     - `ETHTYPE_ARP`（`LWIP_IPV4 && LWIP_ARP`）：同样剥头后 `etharp_input(p, netif)`。
     - `ETHTYPE_IP`（`LWIP_IPV4`）：剥头后 `ip4_input(p, netif)`。
     - 其他 → 统计 `proterr` + `drop`，`pbuf_free()`。
3. 剥头不产生拷贝：`pbuf_header()` 只是移动链头指针；若 pbuf 是只读/不可移动（引用计数不为 1），则报「Can't move over header」并丢弃。

这就是「一次拷贝都不发生」的典型实现——以太网头通过指针前移剥除，载荷原地传给上层。

### 发包路径（ethernet_output）

签名：`ethernet_output(struct netif *netif, struct pbuf *p, const ip4_addr_t *ipaddr, const ip6_addr_t *ip6addr)`（IPv4/IPv6 二者其一非空）。调用者是上层（`ethip6_output` 或 IPv4 输出路径）解析出目的 MAC 后调用。

1. 计算总长 `ETH_PAD_SIZE` 追加到头部预留空间（默认 0）。
2. `pbuf_header(p, -(s16)SIZEOF_ETH_HDR)` 在 pbuf 前端预留 14 字节；失败（无空间可扩）→ 报错返回。
3. 在预留的头部写入 `dest`、`src`（`netif->hwaddr`，断言 hwaddr_len == 6）、`type`（`lwip_htons`）。
4. 交给 `netif->linkoutput(netif, p)`（驱动侧），后者负责把 pbuf 链逐一发送并计算/追加 FCS。

### 校验（checksum）

- 以太网帧自身不计算 IP 校验和；链路层只有 **CRC32 的 FCS**（由网卡硬件完成，lwIP 不计算）。软件可见的校验是 IP/ICMP/TCP/UDP 头校验。
- 这直接影响观察：在 Wireshark 里「以太网校验」列通常显示网卡报告的 FCS 校验结果，与 IP 校验是两回事。
- lwIP 网卡/OS 边界（platform 层）在收包时校验 FCS，错帧在驱动处丢弃，协议栈永远看不到坏帧。

### TSO / GSO / GRO（观察影响层）

这些机制发生在协议栈**之外**的网卡/驱动/OS 网络层，但会显著改变你能观察到的现象：

- **TSO / GSO / GRO 的工作位置**：GSO/GRO 在 Linux 网络层（`net/core/sock.c` / `net/ipv4/`）与驱动边界；TSO 由网卡固件完成，软件只做分段与卸载标记。
- **TSO（TCP 分段卸载）**：TCP 把大段（如 64 KB）交给网卡，由网卡硬件按 MTU 切分并计算每段校验和。抓包时看到的是**切分后**的多帧——这不是 TCP 软件分段的证据。
- **GSO（Generic Segmentation Offload）**：UDP/发送侧，一次写出多个分段的包交给内核拆分；抓包同样看到多帧。
- **GRO（Generic Receive Offload）**：收侧把多个 IP 包合并成一个大段上交 TCP。Wireshark 可能看到重组后的单个大 TCP 段（长度 > MSS），导致你误判 MSS 或观察不到真实线速。
- **对本模块的影响**：`ethernet.c` 是纯软件收发路径，TSO/GSO/GRO 不经过它——因此对照实现（Linux 网络层 + 网卡）是理解「看到的帧 ≠ 应用写出的字节」的关键。MTU 则是软件端真正参与点：IP 分片/PMTU 依据 `netif->mtu` 决策，而 TSO 让大块数据在未先分片的情况下就离开了软件。

### 其他关键机制

- **本地交付/环回**：`netif_loop_output` 把输出包转给 `ip_input` 实现本机环回，走的是与收包一致的分发路径。
- **网卡过滤与状态**：netif 维护 up/down、link up/down、IGMP/MLD 组播过滤钩子；`netif_issue_reports` 在接口 up 时发 gratuitous ARP 与 IGMP report（`netif.c`）。

## 设计取舍

| 取舍 | 选择 | 理由 / 代价 |
| --- | --- | --- |
| 帧长语义 | lwIP 只按 EtherType 分发，不做长度-类型自动判别 | 简化实现、面向现代以太网；代价是 802.3 长度帧被丢弃。对照实现（Linux）用 `eth_type_trans` 显式处理两种语义 |
| 剥头 | `pbuf_header` 指针移动而非 memcpy | 零拷贝；代价是 pbuf 必须可移动（引用计数为 1），否则丢弃 |
| 校验位置 | 帧校验完全委托网卡硬件 | 与「软件只负责协议头部」的分层一致；代价是坏帧在驱动处被丢弃，软件无法统计 |
| 填充 | 假设上层已补齐最小载荷 | 简化；代价是 46 字节最小载荷要求转嫁给 IP/上层 |
| 地址分配 | MAC 由驱动/平台提供，协议栈只读取 `hwaddr` | netif 抽象清晰；代价是驱动必须正确上报 hwaddr_len == 6 |
| 协议层 vs 控制面 | VLAN/bridge/STP/LACP 交给 OVS，本模块只管帧格式与 netif | 符合 §4.2 的选型，避免模块职责膨胀 |

## 不变量

- 处理中的帧 `p->len >= SIZEOF_ETH_HDR`（14 字节）。
- 分发给上层的 pbuf 已剥掉以太网头：上层只看到 IP/ARP 载荷。
- 源 MAC 非全零；类型字段按 `lwip_htons` 保持为大端语义。
- `ethernet_output` 前后 pbuf 的总长度不变：先预留头部，写满后交付驱动，长度守恒。
- netif 的 `hwaddr_len == 6`（`ethernet_output` 中有断言）。
- 一条链路上一帧只交给一个输入路径，分发是确定性的（`switch` 唯一匹配）。
- MTU 是软件可见的最大载荷；超出 MTU 的交付决策（分片或丢弃）在上层完成，帧层不拆包。

## 边界条件与异常处理

- **帧长 < 14 字节**：`ethernet_input` 直接 `pbuf_free` 丢弃。
- **未知 EtherType**：统计 `proterr`/`drop` 后释放；配置了 hook 时可让应用接管（`LWIP_HOOK_UNKNOWN_ETH_PROTOCOL`）。
- **pbuf 不可移动**（引用计数 > 1 或头部无空间）：`pbuf_header` 失败 → 报「Can't move over header」丢弃，绝不进行部分剥除。
- **VLAN 帧**：仅 `ETHARP_SUPPORT_VLAN` 时处理；否则按未知 EtherType 丢弃。优先级/VID 不校验（`ethernet_output` 只断言 `vlan_prio_vid <= 0xFFFF`）。
- **多播/广播**：由上层（IGMP/MLD、IP 组播）决定是否接收；netif 提供 MAC 过滤钩子，协议栈不在此处过滤。
- **同时配置 IPv4+IPv6 的广播帧**：按 EtherType 精确分流，互不干扰；IP 广播（EtherType 0x0800）与 IPv6 多播（0x86DD）各走各的分发。
- **接口 down / 未配置**：netif 状态在 `netif.c` 管理，收包路径由驱动决定是否调用；输出路径由上层先查 up/link 状态。
- **FCS 错帧**：驱动处丢弃，协议栈不可见（这是观察与协议语义之间的一个真实边界）。