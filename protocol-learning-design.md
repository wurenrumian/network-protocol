# 源码导向的网络协议学习设计

## 1. 目标

本项目以协议设计为主线，通过阅读成熟的用户态实现，建立从链路层到应用层、再到高性能网络与 RPC 的整体理解。

目标不是实现一个可替代生产系统的协议栈，而是能够回答：

- 协议要解决什么问题，以及明确不负责什么；
- 报文、状态机、定时器和错误处理如何共同工作；
- 规范中的设计如何落到数据结构、函数和调用路径；
- 不同协议如何在前后层组合，并在约束下演进。

这里的目标用于说明学习方向和观察视角，不作为需要逐项判定的验收条件；具体阅读深度根据协议特点、源码可读性和当前问题取舍。

## 2. 学习原则

1. **协议优先**：先读规范和报文，再看实现细节。
2. **源码为主**：源码是阅读对象，保留上游文件，不要求本项目编译运行。
3. **完整闭环**：每个模块至少追踪一条从输入到输出的真实路径。
4. **问题驱动**：围绕可靠性、寻址、流控、安全、复用等设计问题组织内容。
5. **实现对照**：同一协议优先选择一个主实现，必要时用第二个实现比较取舍。

## 3. 协议模块目录规范

每个协议独立一个目录，目录名使用协议或技术的常用英文名：

```text
<protocol>/
├── README.md
├── protocol.md
├── state-machine.md
├── observations.md      # 有抓包/现象记录时添加
├── references.md
└── src/                 # 选定版本的上游源码，保留原文件结构
    ├── LICENSES/         # 本模块涉及的上游许可证与版权声明
    ├── upstream/         # 上游文件；可直接在副本上加学习注释
    └── README.md         # 文件清单、阅读顺序、调用链与裁剪说明
```

### 文档职责

- **README.md**：模块定位、前置模块、推荐阅读顺序、源码入口。
- **protocol.md**：问题定义、抽象对象、wire format、核心机制、设计取舍、不变量、边界条件和异常处理。
- **state-machine.md**：状态、事件、状态转移、正常/异常时序；无显式状态机的协议记录其处理流程。
- **observations.md**（可选）：使用 Wireshark、tcpdump 或系统工具观察到的报文现象，并链接到对应源码位置；不承担源码讲解或运行要求。
- **references.md**：RFC/标准、论文、上游仓库、固定版本或 commit、其他实现和阅读备注。

`src/README.md` 是源码的导航页，不复述协议内容，只维护：上游版本、每个文件的原始路径、在当前闭环中的职责、推荐阅读顺序、入口函数、结束函数，以及未复制依赖的名称。示例：

```text
1. src/include/tcp.h       TCP 控制块和报文定义
2. src/core/tcp_in.c       收包、序列号检查、ACK 与状态推进
3. src/core/tcp_out.c      分段、ACK、重传与发送
4. src/core/tcp_tmr.c      超时、重传和 TIME-WAIT 清理
```

### 源码选择与注释

源码以成熟用户态实现为主；只有在用户态实现无法说明关键机制时，才补充内核、驱动或硬件相关代码。每个协议原则上确定一个主实现，必要时再选一个对照实现，用来比较设计取舍。

源码选择遵循以下规则：

- 选择一个可以独立追踪的**最小完整闭环**，而不是只摘几个孤立函数；
- 闭环至少覆盖入口、核心数据结构、报文解析/构造、状态转移和出口；
- 协议的定时器、重传、流控、错误处理等机制若参与该闭环，也一并保留；
- 直接复制与闭环相关的完整上游文件，保留原有相对目录结构，不把源码大段粘入 Markdown；
- 与协议无关的通用库、平台适配、构建脚本和生成文件不复制，只在 `README.md` 中记录其依赖关系；
- 一个文件同时包含大量无关功能时，可以保留完整文件，但在 `README.md` 标出本次阅读范围和跳过部分；
- 每个模块记录上游仓库、版本/commit、文件来源和必要的裁剪说明。

源码按三类标记，避免把实现层次混在一起：

```text
core/        协议本身：报文、状态机、定时器、队列
integration/ 与 socket、TLS、事件循环或其他协议的连接
platform/    网卡、系统调用、线程/锁、操作系统适配
```

阅读时先完成 `core/`，再沿一条调用链补 `integration/`；`platform/` 只读支撑当前协议结论所必需的部分。复制完整文件时保留上游路径，并在 `src/README.md` 给出“文件 → 类别 → 阅读范围”的清单；若某文件包含多个类别，不拆改源文件，只用注释标出相关函数。

推荐用一条调用链呈现源码：

```text
协议入口
→ 核心状态机
→ 报文解析/构造
→ 队列、定时器或资源管理
→ 下层发送 / 上层交付
```

例如 TCP 不按目录平铺源码，而是围绕“收到 ACK 后推进发送窗口”这一闭环组织阅读：入口函数、ACK 解析、状态更新、队列释放、唤醒发送，再补充相关定时器和异常分支。

每个源码文件的开头注明它在闭环中的位置、上游原始路径和版本；关键函数旁注明调用者、被调用者和对应的协议机制。源码注释使用统一格式，便于与文档互相跳转：

```c
/* [RFC: section-x] 解析 XXX 字段。
 * [STATE] 从 S1 转为 S2；[INVARIANT] ...；[BOUNDARY] ... */
```

不改变原有控制流和命名；确需修正明显错误时，另加补丁文件并在 `references.md` 说明，不把学习性修改伪装成上游源码。每个模块至少包含：

- 核心数据结构；
- 报文解析与构造；
- 输入/输出主路径；
- 状态转移；
- 定时器、重传、流控或错误处理（若协议具备）。

注释写协议语义，不逐行翻译 C 语法。每处关键注释说明：

- 对应的规范机制或字段；
- 修改/读取了哪个状态；
- 正在维护的不变量；
- 该边界或异常分支为何必须存在。

示例：

```c
/* ACK 推进 snd_una：表示此前发送的数据已被对端确认，
 * 同时允许释放发送队列中不再需要重传的 segment。 */
```

## 4. 协议阅读顺序

以下顺序提供一条从底层到上层的主干，同时保留横向机制和专题分支。它不是必须一次性线性完成的课程进度；进入某个模块时，可沿依赖关系回看前置模块。

```text
协议抽象与报文编码
→ Ethernet / VLAN / bridge
→ ARP / NDP / DHCP
→ IPv4 / IPv6 / ICMP
→ 路由、转发、NAT、Netfilter、Conntrack
→ UDP
→ TCP
→ DNS
→ TLS
→ HTTP/1.1
→ HTTP/2
→ QUIC / HTTP/3
→ RPC 与序列化
→ 消息、实时和存储协议
→ 高性能网络
→ RDMA
→ 自定义协议设计
```

其中，前半段（协议抽象与编码至 QUIC / HTTP/3）构成协议主干；RPC 与序列化、高性能网络、RDMA 和自定义协议设计是建立主干理解后的扩展方向。定时器、队列、流控、错误处理、复用和安全等机制则贯穿各层，按实际协议在相应模块中横向比较。

### 4.0 主实现与源码范围

下表是默认选型。除非后续明确更换，否则各模块按此实现建立 `src/` 目录。

| 模块 | 主实现 | `src/` 重点 | 对照/补充实现 |
| --- | --- | --- | --- |
| Ethernet、ARP、IP、ICMP、UDP、TCP | **lwIP** | `src/core/`、`src/include/` 中对应协议文件及 netif 抽象 | Linux bridge/VLAN；必要时补驱动边界 |
| VLAN、bridge、bonding | **Open vSwitch** | datapath/userspace 核心转发、端口和流表代码 | Linux bridge/vlan 工具 |
| 路由协议（RIP/OSPF/BGP） | **FRRouting** | `zebra/`、`ospfd/`、`bgpd/` 的协议状态机和报文处理 | BIRD |
| DNS | **Unbound** | wire parser、递归解析、缓存和验证路径 | BIND；客户端可补 c-ares |
| TLS | **BoringSSL** | record、handshake、密钥调度、会话恢复 | OpenSSL 或 rustls |
| HTTP/1.1 | **nginx** | HTTP parser、request/response、keepalive、chunked | curl/llhttp |
| HTTP/2 | **nghttp2** | frame、stream、HPACK、flow control | nginx HTTP/2 模块 |
| QUIC/HTTP/3 | **quiche** | packet、ACK/loss、stream、flow control、TLS 集成 | ngtcp2 或 MsQuic |
| RPC 与序列化 | **gRPC + protobuf** | channel、stream、metadata、deadline、编码/解码 | Apache Thrift、Cap’n Proto |
| 事件循环与 I/O | **nginx + liburing** | event loop、epoll、io_uring 提交/完成路径 | Redis ae |
| 用户态高速包处理 | **DPDK** | mbuf、ring、PMD、收发批处理 | mTCP、Seastar、XDP/AF_XDP |
| RDMA | **rdma-core** | `libibverbs/`、`librdmacm/`、examples/perftest | Soft-RoCE（RXE）、内核 verbs |

实现选择的依据是：协议覆盖完整、项目长期维护、源码可独立阅读、规范与实现关系清晰。高性能模块不要求把全部驱动复制进仓库，只保留能解释数据路径和关键抽象的完整文件。

### 4.1 协议抽象与编码

统一掌握报文布局、字节序、长度与边界、TLV、校验、版本/扩展、状态机、超时和错误模型。此模块只建立分析语言，不追求全面实现。

### 4.2 链路层

覆盖 Ethernet II/802.3、MAC 学习、VLAN（802.1Q）、bridge、STP、LACP、LLDP，以及 MTU、checksum/TSO/GSO/GRO 等会影响观察结果的机制。

VLAN、bridge、STP、LACP 等链路层控制与转发机制的主实现为 Open vSwitch；Ethernet 帧格式、基础网卡抽象和收发边界配合 lwIP 与 DPDK 示例阅读。必要时引用 Linux bridge/VLAN/bonding 或驱动代码解释边界，但不以 Linux 内核作为主源码来源。

### 4.3 邻居、网络层与路由

覆盖 ARP、IPv6 NDP、DHCP、IPv4/IPv6、ICMP、最长前缀匹配、转发、分片/PMTU、NAT 和 conntrack。

主实现：lwIP（完整、可追踪的用户态协议栈）；路由控制面使用 FRRouting 阅读 RIP/OSPF/BGP，BIRD 仅作对照。

### 4.4 传输层

先读 UDP 的端口复用和校验，再读 TCP 的连接状态、序列号/确认、重传、流量控制、拥塞控制、关闭和 TIME-WAIT；随后比较 SCTP、DCCP 与 QUIC 的取舍。

主实现：lwIP；高性能 TCP 另读 mTCP 或 Seastar 的数据路径。QUIC 固定以 quiche 为主，必要时用 ngtcp2 或 MsQuic 对照。

### 4.5 DNS、TLS 与 Web 协议

DNS 关注 wire format、递归、缓存、委派、DNSSEC；TLS 关注 record、握手、证书、密钥调度、恢复和 0-RTT；HTTP 按 1.1→2→3 对比消息、帧、流、压缩和队头阻塞。

主实现：Unbound；TLS 使用 BoringSSL；HTTP 使用 nginx、nghttp2、quiche（HTTP/3），curl/llhttp 作为客户端或 parser 对照。

### 4.6 RPC 与序列化

顺序：ONC RPC → JSON-RPC → Thrift → Protocol Buffers → gRPC → Cap’n Proto/FlatBuffers。

重点阅读接口描述、编码、请求 ID、连接复用、streaming、deadline、重试/幂等、metadata、认证、服务发现和负载均衡。

主实现：gRPC core + protobuf；Apache Thrift、Cap’n Proto 作为对照，必要时比较 Tars/Dubbo 的协议设计。

### 4.7 高性能网络与 RDMA

高性能顺序：阻塞/非阻塞 socket → select/poll/epoll/kqueue → Reactor/Proactor → sendfile/splice → io_uring → XDP/AF_XDP → DPDK → RDMA → SmartNIC。

主实现：nginx/Redis 事件循环、liburing、DPDK、mTCP、Seastar；RDMA 以 rdma-core 为主，阅读 `libibverbs`、`librdmacm`、示例和 perftest，并在需要时补充 Soft-RoCE（RXE）。

RDMA 阅读顺序：MR → QP → WR/WC → CQ → RDMA CM → SEND/RECV → READ/WRITE → RoCE/InfiniBand。

## 5. 每个模块的阅读产出

阅读一个模块时，建议在目录中逐步留下以下材料；这些是组织阅读和复盘的建议，不构成统一的完成门槛：

1. 一份能独立说明协议设计的 `protocol.md`；
2. 一份状态机/时序说明；
3. 一条标注入口、核心路径和异常分支的源码闭环；
4. 源码中的协议语义注释；
5. 固定版本、规范和实现来源；
6. （可选）抓包或工具观察与源码的对应记录。

## 6. 版本、许可证与源码管理

每个模块在 `references.md` 固定上游仓库、版本/commit 和协议版本；复制源码时保留原版权与许可证文件，并在模块 README 中注明修改仅限学习注释。若许可证不适合直接复制，则改为记录路径、补丁或链接，不改变上游授权范围。

## 7. 模块之间的扩展关系

学习过程中始终维护以下连接：

```text
Ethernet → VLAN/bridge → VXLAN/overlay → DPDK/XDP
IP → 路由/NAT → 容器网络/CNI
TCP → TLS → HTTP/1.1 → HTTP/2
UDP → QUIC → HTTP/3
Protobuf → gRPC → 服务发现/负载均衡/重试
QP/CQ/WR → RoCE/InfiniBand → RDMA 应用协议
```

扩展协议时沿用同一目录规范，不另设一套笔记格式。
