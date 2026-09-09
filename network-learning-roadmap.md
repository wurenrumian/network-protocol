# 网络协议源码阅读路线

这份路线服务于本仓库的核心目标：以 RFC/标准建立协议模型，再通过成熟实现源码追踪一条真实的输入—处理—输出路径。

阅读重点不是记住所有字段，而是持续回答：协议解决什么问题、明确不解决什么问题；报文如何被切分和校验；状态、队列、定时器和缓存如何协同；异常输入、丢包、乱序、超时和资源耗尽时会发生什么；规范要求最终落在哪个数据结构、函数和分支中。

## 阅读方法

每个模块建议按以下顺序推进：

1. 阅读模块 `README.md`，确认范围、前置知识和主实现；
2. 阅读 `protocol.md`，建立报文结构、对象关系和关键不变量；
3. 阅读 `state-machine.md`，整理状态、事件、定时器和异常转移；
4. 阅读 `references.md`，查阅与当前问题直接相关的 RFC 章节；
5. 按 `src/README.md` 的调用链进入源码，先读 `core/`，再补 `integration/` 和 `platform/`；
6. 用抓包、命令或最小实验验证一个关键结论，并记录到模块的 `observations.md`；
7. 总结实现与规范的差异、裁剪范围和仍未解释的依赖。

源码阅读以“最小完整闭环”为单位：

```text
协议入口 → 报文解析 → 状态/缓存/队列更新
        → 定时器或错误分支 → 报文构造 → 下层发送或上层交付
```

## 第一阶段：建立阅读语言

### 1. 协议抽象与编码

先阅读 [protocol-abstraction](protocol-abstraction/)：

- 报文布局、固定头、变长字段和嵌套结构；
- 字节序、长度、边界检查和整数溢出；
- TLV、类型标签、版本和扩展；
- 校验和、CRC、MAC、签名的覆盖范围与责任边界；
- 显式状态机与由序号、窗口、游标隐含表达的状态机。

参考重点：RFC 791、RFC 8200、RFC 8446、RFC 7540、RFC 9000，以及各模块 `references.md` 中对应的 wire format 章节。

产出应是一份通用检查表：看到一个协议时，能够定位长度来源、边界位置、错误处理方式和状态保存位置。

## 第二阶段：链路层与邻居发现

### 2. Ethernet、VLAN 与 bridge

阅读顺序：

1. [ethernet](ethernet/)：Ethernet II/802.3 帧、EtherType/长度、MTU、padding、FCS 和网卡收发边界；
2. [vlan-bridge](vlan-bridge/)：VLAN 标签解析、端口状态、MAC 学习、泛洪和控制协议；
3. 回到 Ethernet，追踪一个帧从分发到 `linkoutput` 的路径。

重点疑问：

- 一个帧在什么位置被识别为 ARP、IPv4、IPv6 或 VLAN？
- MAC 学习和转发决策分别保存什么状态？
- STP/LACP 状态变化如何影响数据转发？
- MTU、分片和 checksum offload 为什么会影响抓包结果？

参考重点：IEEE 802.3、IEEE 802.1Q、RFC 894；源码重点以 lwIP 和 Open vSwitch 模块导航为准。

### 3. ARP、NDP 与 DHCP

阅读顺序：

1. [arp-ndp](arp-ndp/)：地址解析、邻居缓存、NUD、DAD、RA/RS 和队列；
2. [dhcp](dhcp/)：DHCPv4 DORA、租约 T1/T2/T0、DHCPv6 无状态配置；
3. 对照 UDP、IPv4/IPv6，理解这些协议如何借助下层完成收发。

重点疑问：

- 未知下一跳时，数据包为什么要排队？队列何时释放？
- ARP 和 NDP 的状态机、缓存老化和安全边界有什么差异？
- DHCP 如何在没有可用 IP 地址时完成初始通信？
- 租约定时器与报文重传定时器分别解决什么问题？

参考重点：RFC 826、RFC 4861、RFC 4862、RFC 2131、RFC 2132、RFC 3315/8415。

## 第三阶段：网络层与传输层

### 4. IPv4、IPv6 与 ICMP

阅读 [ipv4-ipv6](ipv4-ipv6/) 和 [icmp](icmp/)：

- IPv4/IPv6 头部与地址选择；
- 路由查找、转发、分片与 PMTU；
- IPv4/IPv6 扩展头和 Next Header 分发；
- ICMP 错误报告、Echo、Packet Too Big 和参数问题；
- ICMP 与 TCP/UDP、NDP 之间的反馈边界。

重点疑问：收到一个包后，在哪一层决定“本机接收、转发或丢弃”？差错报文为什么只能携带原包的一部分？IPv4 路由器分片与 IPv6 PTB 带来了什么实现差异？

参考重点：RFC 791、RFC 8200、RFC 4443、RFC 792、RFC 1191、RFC 8201。

### 5. UDP 与 TCP

先读 [udp](udp/)，再读 [tcp](tcp/)：

1. UDP：端口绑定、PCB 查找、校验和、广播/多播和无连接收发；
2. TCP 建连：SYN、能力协商、初始序列号和半连接状态；
3. TCP 传输：ACK、发送/接收窗口、乱序队列、重传和拥塞窗口；
4. TCP 关闭：FIN、RST、半关闭、TIME-WAIT 和资源回收。

重点疑问：TCP 状态由哪个控制块和哪些边界变量保存？`snd_una`、`snd_nxt`、窗口和队列如何保持不变量？ACK 推进后哪些数据可以释放？RTO、快速重传、拥塞控制和应用层超时分别负责什么？

参考重点：RFC 9293、RFC 1122、RFC 5681、RFC 6298、RFC 2018、RFC 7323。

## 第四阶段：名称、安全与 Web 协议

### 6. DNS

阅读 [dns](dns/) 时沿“客户端请求 → 缓存命中/未命中 → 委派迭代 → 上游应答 → 回包”闭环：

- DNS header、问题区、RR、name compression 和 EDNS；
- 消息缓存、RRset 缓存和负缓存；
- root hints、委派、CNAME/DNAME 和迭代状态；
- DNSSEC 验证边界、缓存污染和响应清理。

参考重点：RFC 1034、RFC 1035、RFC 2308、RFC 6891、RFC 4033–4035、RFC 9156。

### 7. TLS

阅读 [tls](tls/) 时分开看两条状态线：record 层的收发/加密，以及握手层的消息顺序/密钥阶段：

- record framing、明文长度和 AEAD；
- ClientHello/ServerHello、证书、密钥交换和 Finished；
- transcript、traffic secret、会话恢复和 0-RTT；
- 非阻塞 BIO、异步证书/私钥操作和重入；
- 解密失败、版本不匹配、消息顺序错误和证书失败。

参考重点：RFC 8446、RFC 5246、RFC 7301、RFC 9001；源码以 BoringSSL 导航和固定 commit 为准。

### 8. HTTP/1.1、HTTP/2 与 HTTP/3

按演进关系阅读：

1. [http1-1](http1-1/)：字节流如何切分成请求/响应，keepalive、Content-Length、chunked 和连接关闭；
2. [http2](http2/)：frame、stream、SETTINGS、HPACK、优先级和流控；
3. [quic-http3](quic-http3/)：packet number space、ACK/loss、PTO、连接迁移、stream 和 TLS 集成。

重点疑问：HTTP/1.1 的 framing 歧义如何导致解析安全问题？HTTP/2 的连接级和流级状态如何协同？HPACK/QPACK 为什么需要动态表和严格解码状态？QUIC 如何重新组合可靠字节流、拥塞控制和多路复用？

参考重点：RFC 9110、RFC 9112、RFC 7540、RFC 7541、RFC 9113、RFC 9000、RFC 9002、RFC 9114。

## 第五阶段：路由、RPC 与高性能实现

### 9. 路由控制面

阅读 [routing](routing/)：先理解 zebra/RIB/FIB 的职责划分，再追踪 OSPF 的邻居/LSA 和 BGP 的会话/UPDATE，最后比较控制面状态如何影响实际转发表。

参考重点：RFC 2328、RFC 4271、RFC 4456，以及模块中记录的 FRRouting 固定版本。

### 10. RPC 与序列化

阅读 [rpc](rpc/) 和 [custom-protocol](custom-protocol/)：

- protobuf 的 tag、varint、length-delimited 和嵌套消息；
- gRPC call、metadata、stream、deadline、取消和 completion queue；
- RESP、MySQL、Kafka 的 framing、协商、错误模型和兼容性策略。

重点疑问：编码层如何区分协议错误和业务错误？deadline、取消和重试如何跨层传播？连接复用与消息顺序由哪个对象负责？协议如何在版本演进中保持向后兼容？

### 11. 事件循环与高速数据路径

阅读 [high-performance](high-performance/) 和 [rdma](rdma/)：

1. 阻塞/非阻塞 I/O 与 epoll 的就绪语义；
2. nginx/Redis 风格事件循环的连接、事件和定时器管理；
3. io_uring 的 SQ/CQ、异步提交、完成通知和缓冲区生命周期；
4. DPDK/XDP 的用户态收发、批处理、内存池和所有权；
5. RDMA 的 MR、QP、WR/WC、CQ、CM 与 SEND/READ/WRITE。

重点疑问：就绪模型和完成模型有什么状态差异？零拷贝消除了哪一次拷贝，又新增了哪些生命周期约束？批处理、缓存局部性、NUMA 和网卡队列如何影响路径？

## 横向专题

完成主干后，跨模块整理以下专题：

- framing：HTTP/1.1、HTTP/2、DNS、RESP、protobuf；
- 状态机：TCP、DHCP、NDP、TLS、QUIC、OSPF/BGP；
- 定时器：ARP/NDP 老化、DHCP 租约、TCP RTO、QUIC PTO、DNS TTL；
- 可靠性：TCP、QUIC、DNS、DHCP 的重传与失败模型；
- 流控：TCP 接收窗口、HTTP/2 window、QUIC flow control、RDMA 队列；
- 安全边界：NDP 欺骗、DNS 污染、TLS 身份验证、HTTP framing、RPC 认证；
- 多路复用：端口、HTTP/2 stream、QUIC stream、gRPC channel。

每个专题最好形成一张对比表，并链接回具体模块文档和源码函数。

## 实验与验证

实验用于验证阅读结论，不替代源码阅读。可按主题使用：

- `tcpdump` / Wireshark：观察报文字段、顺序、重传和状态变化；
- `ip`、`ss`、`bridge`、`ethtool`：观察接口、邻居、路由、队列和 offload；
- `dig`、`curl`、`openssl s_client`：验证 DNS、HTTP、TLS；
- `tc netem`：注入延迟、丢包、乱序和限速；
- `strace`、`perf`、eBPF：把系统调用、调度和延迟与源码路径对应起来。

每次实验至少记录环境、命令、现象、关键报文、源码入口、结论和异常情况，并放入对应模块的 `observations.md`。

## 进阶分支

主干完成后再选择方向：NAT/conntrack/防火墙/VPN、STUN/TURN/ICE/WebRTC、RTP/RTCP、eBPF/XDP/DPDK/SmartNIC、服务发现与负载均衡、重试/熔断、packetdrill，以及基于 RESP、Kafka 或自定义二进制协议的兼容性实验。

进阶主题仍沿用同一方式：先固定参考规范和版本，再选择最小源码闭环，最后用实验验证关键行为。
