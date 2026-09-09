# Network Protocol

一个以协议设计为主线、以成熟用户态实现源码为主要阅读对象的计算机网络学习仓库。

仓库的目标不是实现一个可替代生产系统的完整协议栈，而是把以下几件事串起来：

- 协议要解决什么问题，以及明确不负责什么；
- 报文格式、状态机、定时器和错误处理如何协同工作；
- RFC/标准中的设计如何落到数据结构、函数和调用路径；
- 不同协议如何组合，并在可靠性、性能、安全和兼容性约束下演进。

## 内容总览

每个主题通常包含：

```text
<module>/
├── README.md          # 模块定位、前置知识和源码入口
├── protocol.md        # 协议设计、报文格式、机制和不变量
├── state-machine.md   # 状态、事件、转移和异常路径
├── references.md      # RFC、上游项目、版本和阅读备注
└── src/               # 选定版本的上游源码与源码导航
```

| 模块 | 关注内容 |
| --- | --- |
| [protocol-abstraction](protocol-abstraction/) | 报文抽象、编码、字节序、TLV、校验和扩展 |
| [ethernet](ethernet/) | Ethernet 帧、EtherType、MTU、网卡收发边界 |
| [vlan-bridge](vlan-bridge/) | VLAN、bridge、MAC 学习、STP、LACP、LLDP |
| [arp-ndp](arp-ndp/) | ARP、IPv6 NDP、邻居缓存、NUD、DAD |
| [dhcp](dhcp/) | DHCPv4/v6、地址分配、租约和重试 |
| [ipv4-ipv6](ipv4-ipv6/) | IPv4/IPv6、分片、扩展头和 PMTU |
| [icmp](icmp/) | ICMP/ICMPv6、差错报告、Echo 和 PTB |
| [routing](routing/) | RIP、OSPF、BGP、路由状态机和转发控制面 |
| [udp](udp/) | UDP 报文、端口复用、校验和和收发路径 |
| [tcp](tcp/) | TCP 连接、序列号、ACK、重传、流控和拥塞控制 |
| [dns](dns/) | DNS wire format、递归、缓存、委派和 DNSSEC 边界 |
| [tls](tls/) | TLS record、握手、密钥交换和会话恢复 |
| [http1-1](http1-1/) | HTTP/1.1 解析、消息 framing、keepalive 和 chunked |
| [http2](http2/) | HTTP/2 frame、stream、HPACK 和流控 |
| [quic-http3](quic-http3/) | QUIC packet、ACK/loss、拥塞控制和 HTTP/3 |
| [rpc](rpc/) | protobuf 编码、gRPC call、metadata、deadline 和取消 |
| [high-performance](high-performance/) | Reactor、epoll、io_uring、零拷贝和高速 I/O |
| [rdma](rdma/) | MR、QP、WR/WC、CQ、RDMA CM 和 RoCE |
| [custom-protocol](custom-protocol/) | RESP、MySQL、Kafka 与自定义协议设计方法 |

## 推荐阅读顺序

主干路径如下：

```text
协议抽象与编码
→ Ethernet / VLAN / bridge
→ ARP / NDP / DHCP
→ IPv4 / IPv6 / ICMP
→ 路由与转发
→ UDP → TCP
→ DNS → TLS
→ HTTP/1.1 → HTTP/2 → QUIC / HTTP/3
→ RPC 与序列化
→ 高性能网络 → RDMA
→ 自定义协议设计
```

进入一个模块后，建议按照以下顺序阅读：

1. 先读模块 `README.md`，明确范围和前置知识；
2. 阅读 `protocol.md`，建立协议模型和 wire format；
3. 阅读 `state-machine.md`，理解正常与异常路径；
4. 查看 `references.md`，对照 RFC 和固定版本；
5. 最后按照 `src/README.md` 的调用链阅读上游源码。

## 源码说明

`src/upstream/` 中的代码是为学习而保留的上游源码副本，不保证能够脱离原项目独立编译。每个模块的 `src/README.md` 记录：

- 上游仓库、版本和 commit；
- 文件的原始路径和在阅读闭环中的职责；
- 推荐阅读顺序、入口函数和结束函数；
- 未复制的依赖和有意跳过的范围。

源码许可证和版权声明保留在各模块的 `src/LICENSES/` 中。源码副本与学习笔记中的上游实现保持边界，协议解释和阅读结论以模块文档为准。

## 设计文档

- [源码导向的网络协议学习设计](protocol-learning-design.md)：模块规范、源码选择原则、注释约定和总体路线。
- [计算机网络学习路线](network-learning-roadmap.md)：纵向协议栈、横向专题、实践工具和扩展方向。

## 仓库状态

当前仓库内容已完成初始整理和完整性验证，适合作为协议源码阅读与持续补充的基线。后续新增内容应优先遵循现有模块结构，并在对应模块的 `references.md` 中固定来源和版本。
