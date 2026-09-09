# UDP · protocol

## 问题定义

UDP 解决的核心问题：在 IP 的「主机到主机」交付之上，提供**进程到进程**的多路复用，同时保持极简与尽力而为。

- **进程寻址**：IP 只把报文送到主机，无法区分主机内哪个进程应接收。UDP 用 16 位源/目的端口把报文分发给特定 PCB（Protocol Control Block）。
- **尽力而为交付**：不建立连接、不确认、不重传、不排序、不流控、不拥塞控制。报文可能丢失、乱序、重复或损坏，UDP 不负责恢复。
- **校验**：可选校验和，用于检测传输或内存中的比特错误；IPv6 下校验和强制必选。
- **明确不负责**：可靠性、顺序保证、重复消除、流量控制、拥塞控制、路径 MTU 发现、分片重组（分片由 IP 层负责）。这些被留给应用或上层协议（如 QUIC、RUDP）。

## 抽象对象

- **PCB（`struct udp_pcb`，`src/include/lwip/udp.h`）**：UDP 的协议控制块，是端口复用的基本单元。关键字段：
  - `local_ip` / `local_port`：本地绑定地址与端口；
  - `remote_ip` / `remote_port`：对端地址与端口（仅 connected PCB 使用）；
  - `flags`：`UDP_FLAGS_CONNECTED`、`UDP_FLAGS_MULTICAST_LOOP`、`UDP_FLAGS_NOCHKSUM`、`UDP_FLAGS_UDPLITE`；
  - `recv` / `recv_arg`：接收回调与用户参数；
  - `next`：PCB 链表指针，用于端口表遍历。
- **端口表**：lwIP 用 `udp_pcbs` 链表维护全部 UDP PCB，`udp_input` 内顺序遍历查找匹配项（而非哈希表）。`udp_new` 分配 PCB，`udp_remove` 从链表摘除。
- **`udp_hdr`（`src/include/lwip/prot/udp.h`）**：8 字节线格式头，见 wire format。
- **`struct pbuf`**：lwIP 的报文缓冲抽象，`udp_input` 收到的数据以 pbuf 链传给回调，`udp_sendto` 以 pbuf 封装发送。

## wire format

UDP 头固定 8 字节（`udp_hdr`，`src/include/lwip/prot/udp.h`）：

| 偏移 | 字段 | 长度 | 说明 |
| --- | --- | --- | --- |
| 0 | src | 2 | 源端口，可为 0（未指定） |
| 2 | dest | 2 | 目的端口 |
| 4 | len | 2 | UDP 数据报总长度（头 + 载荷），网络字节序 |
| 6 | chksum | 2 | 校验和，0 表示未计算（仅 IPv4 允许） |

- 长度字段最小为 8（空载荷）；`udp_input` 只检查 `p->len < UDP_HLEN` 的最小长度，不用 `udphdr->len` 截断。
- **校验和**：覆盖 UDP 头 + 载荷 + **伪头（pseudo-header）**。伪头不传输，仅参与计算：
  - IPv4 伪头：源 IP、目的 IP、0、协议号（17）、UDP 长度；
  - IPv6 伪头：源/目的地址（128 位）、UDP 长度、3 字节 0、next header（17）。
  - 计算算法为 16 位反码和（one's complement sum），取反后存入 `chksum`。lwIP 用 `inet_chksum_pseudo`（IPv4）与 `ip6_chksum_pseudo`（IPv6）实现。
- IPv4 下 `chksum = 0` 表示发送方未计算校验和，接收方应跳过校验；IPv6 下校验和必选，`chksum` 必须有效（RFC 6935/6936）。

## 核心机制

### 绑定与连接

- **`udp_bind`**：为 PCB 设置 `local_ip` 与 `local_port`，并加入 `udp_pcbs` 链表。端口为 0 时由内核选择空闲端口。绑定后 PCB 可接收目的端口匹配的报文。
- **`udp_connect`**：设置 `remote_ip`/`remote_port`，置 `UDP_FLAGS_CONNECTED`。**不发送任何报文、不建立连接**——仅把 PCB 固定到唯一对端，使 `udp_send`（无地址参数的发送）可用，并让接收过滤只接受该对端的报文。`udp_disconnect` 清除该状态。
- 无连接的 PCB 必须用 `udp_sendto`（携带目的地址）发送。

### 端口查找与复用

- `udp_input` 顺序遍历 `udp_pcbs`，按目的端口、目的 IP、源端口、源 IP 逐级匹配：
  1. 先匹配 connected PCB（要求源端口/源 IP 与 PCB 的 remote 一致）；
  2. 再匹配未连接但绑定本地端口的 PCB；
  3. 最后匹配「通配」PCB（`local_port == 0`，即未绑定端口、由 `udp_new` 直接创建的接收者，常见于 DHCP 等）。
- **端口复用**：多个 PCB 可绑定同一端口（如多播/广播接收者，或一个 connected + 多个 unconnected）。查找时 connected PCB 优先，保证定向报文命中正确的接收者；无精确匹配时按绑定端口分发。lwIP 的复用是「链表 + 顺序匹配」，与 Linux 的哈希表 + reuseport 策略不同。

### 校验

- **发送**：`udp_sendto` 计算伪头校验和并写入 `chksum`；若 `UDP_FLAGS_NOCHKSUM` 置位（仅 IPv4）则写 0。IPv6 下不允许跳过。
- **接收**：`udp_input` 中先遍历 `udp_pcbs` 查找匹配 PCB（connected → bound → wildcard），若命中或报文目的地为本机，再在校验分支用伪头校验和验证；失败则丢弃报文并计数（`lwip_stats`）。

### 收包路径（`udp_input`）

1. 由 `ip4_input`/`ip6_input` 按 IP protocol 字段（17）调用；
2. 解析 `udp_hdr`，检查最小长度（`p->len < UDP_HLEN` 则丢弃）；
3. 遍历 `udp_pcbs` 查找匹配 PCB；
4. 命中（或目的地为本机）则在校验分支验证校验和（失败即丢弃）；
5. 命中则调用 PCB 的 `recv` 回调，把载荷 pbuf 上抛给上层；未命中则丢弃（并可能回复 ICMP 端口不可达，由上层策略决定）。

### 发包路径（`udp_sendto`/`udp_send`）

1. 确定目的地址（`udp_sendto` 显式传入；`udp_send` 用 PCB 的 remote）；
2. 计算校验和（含伪头）；
3. 构造 `udp_hdr` 与载荷 pbuf，调用 `ip4_output_if`/`ip6_output_if` 交给 IP 层发送；
4. 广播/多播发送受 `SOF_BROADCAST` 选项与 `LWIP_MULTICAST_TX_OPTIONS` 控制（由 `ip_get_option` 检查），`UDP_FLAGS_MULTICAST_LOOP` 仅控制多播回环标志。

## 设计取舍

- **无连接、无状态**：PCB 只有绑定信息，没有连接状态机、定时器或序列号，因此实现极简、内存占用小，适合嵌入式场景（lwIP 的定位）。
- **顺序遍历端口表**：lwIP 用链表 + 线性查找而非哈希表，换取简单与确定性；PCB 数量少时足够。Linux 内核用哈希表应对高并发。
- **校验和放在软件路径**：lwIP 默认软件计算校验和，硬件 offload 由网卡驱动层处理，不在 UDP 核心。
- **复用策略**：connected PCB 优先匹配，保证「同一端口多个接收者」时定向报文不被通配 PCB 抢走；代价是查找需遍历并比较多个字段。
- **长度字段冗余**：`len` 与 IP 载荷长度并存，`udp_input` 以 pbuf 实际长度为准，不按 `len` 截断，仅在不足 `UDP_HLEN` 时丢弃。

## 不变量

- PCB 的 `local_port` 一旦绑定，在 `udp_remove` 前保持不变；connected PCB 的 remote 三元组（remote_ip、remote_port、local_port）唯一标识一个「会话」。
- 端口查找顺序固定：connected → bound → wildcard；匹配优先级不可颠倒，否则定向分发失效。
- `udp_input` 只保证 `p->len >= UDP_HLEN`（`UDP_HLEN == 8`）；上抛给回调的载荷为剩余 pbuf，不按 `udphdr->len` 截断。
- IPv6 下校验和必选且必须有效；IPv4 下 `chksum == 0` 表示未校验。
- 每个 PCB 在链表中至多出现一次；`udp_remove` 后 PCB 不再被 `udp_input` 的遍历命中。

## 边界条件与异常处理

- **长度异常**：`p->len < UDP_HLEN` → 丢弃（`udp_input` 直接返回）。
- **校验失败**：丢弃报文，不通知发送方（尽力而为的体现）；统计计数累加。
- **无匹配 PCB**：丢弃；是否回 ICMP 端口不可达由上层/IP 策略决定，UDP 核心不强制。
- **端口冲突**：`udp_bind` 绑定已被占用的端口时返回错误（`ERR_USE`），除非该端口允许复用。
- **`udp_send` 未连接**：PCB 无 remote 时返回错误（`ERR_ARG`），必须用 `udp_sendto`。
- **目的端口为 0**：不合法，发送时返回错误。
- **广播/多播**：发送前需置位对应 flag，否则 IP 层拒绝发送到广播/多播地址。
- **源端口为 0**：接收方无法用源端口做复用匹配，仅能按目的端口分发。
- **多播/广播接收**：多个 PCB 绑定同一端口时，广播/多播报文会分发给所有匹配的 unconnected PCB（复用语义），而单播报文只命中 connected 或最具体的匹配。