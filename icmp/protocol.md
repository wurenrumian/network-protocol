# ICMP · protocol

## 问题定义

IP 是尽力而为、无连接的网络层协议：它只负责尽力投递，不向源节点报告失败原因，也不提供主动诊断手段。当问题发生时，源节点只能盲目等待，无法区分「路由不存在」「目标端口关闭」「TTL 耗尽」「报文太大」等不同原因，也就无法决定是否需要重试、如何调整路径或报文大小。

ICMP / ICMPv6 解决的问题就是给 IP 层补上两样东西：

1. **差错报告**：当报文无法投递或无法继续转发时，向源节点回送一条包含原因和原始报文前缀的差错消息，让源节点能够（a）定位是哪条传输流出了错，（b）依据原因做出调整；
2. **探测与通知**：echo request/reply 提供可达性与往返时延探测；ICMPv6 的 Packet Too Big 把「下一跳 MTU 不足」直接通知源节点，是 IPv6 PMTUD 唯一的信号来源。

设计约束与边界：

- 差错报文本身不可靠：ICMP 不重传、不确认，源节点只能把它当作「尽力而为的提示」，不能依赖其送达（RFC 792 §1、RFC 4443 §2.4「对 ICMP 差错消息不响应 ICMP 差错消息」）；
- 差错报文必须受速率限制，否则错误风暴会放大网络故障；
- 差错报文不带回整个原始报文，只带回固定前缀（IPv4 常见为「IP 头 + 8 字节」），避免放大流量，同时足以覆盖 TCP/UDP 头以定位传输连接；
- ICMP 明确不负责：数据重传、路径选择、拥塞控制、应用层可达性确认。

## 抽象对象

- **ICMP 报文（icmp_echo_hdr / icmp6_hdr）**：type（类型）+ code（细分类别）+ 校验和，加上一个 32 位的「数据字段」。IPv4 中该字段按 echo 需要拆为 id + seqno；ICMPv6 中为 data（PTB 时承载 MTU，PP 时承载 pointer 偏移）。lwIP 用 `struct icmp_echo_hdr`（type/code/chksum/id/seqno，8 字节）作为通用的 ICMP 头形态，差错报文本身复用 echo 头结构、只把 id/seqno 清零。
- **原始报文前缀**：差错报文的载荷部分，即触发差错的原始 IP 报文（的头 + 前缀），用于定位是哪个源/端口/连接出了错。
- **source/dest 地址与 netif**：收包上下文（`ip4_current_*` / `ip6_current_*`），决定响应报文以谁为源、以谁为目的、走哪个接口。IPv6 的地址带 zone（scope）信息，丢失 zone 会把 link-local 响应发到错误链路上，这是 lwIP 单独维护这些上下文的原因。
- **netif 校验和策略**：`NETIF_CHECKSUM_CHECK_ICMP(_6)` / `NETIF_CHECKSUM_GEN_ICMP(_6)` 控制每个接口收/发时是否校验或生成 ICMP 校验和（可用 `LWIP_CHECKSUM_CTRL_PER_NETIF` 按接口覆盖）。

## wire format

### ICMPv4（RFC 792；lwIP `struct icmp_echo_hdr`，8 字节）

| 字段 | 长度 | 含义 |
| --- | --- | --- |
| type | 8 bit | 消息类型（如 echo=8、echo reply=0、DUR=3、TE=11、PP=12） |
| code | 8 bit | 类型内的细分类别（差错类型用 0/1/... 区分子原因） |
| chksum | 16 bit | 对整个 ICMP 报文（含数据）的补码和校验 |
| id / seqno | 16 + 16 bit | 仅 echo request/reply 使用，用于匹配请求与应答、检测丢失/乱序；差错报文把这两项置 0，把 32 位作为无用/保留 |

type/code 组合举例：

- `0/0` echo reply；`8/0` echo request；
- `3/*` destination unreachable（code 0=net, 1=host, 2=protocol, 3=port, 4=需要分片但 DF 置位, 13=管理性禁止……）；
- `11/*` time exceeded（code 0=TTL 超时, 1=分片重组超时）；
- `12/*` parameter problem（code 0=指针字段指向出错字节，1=缺少选项）。

### ICMPv6（RFC 4443；lwIP `struct icmp6_hdr`，8 字节）

| 字段 | 长度 | 含义 |
| --- | --- | --- |
| type | 8 bit | 错误类 0–127，信息类 128–255 |
| code | 8 bit | 类型内细分类别 |
| chksum | 16 bit | ICMPv6 校验和**必须**覆盖伪头部（IPv6 头中的 src/dest 地址、Next Header=58、报文总长），即与 TCP/UDP 相同的伪头部校验，而非 ICMPv4 那样只覆盖 ICMP 报文本身 |
| data | 32 bit | 类型相关：PTB 时为下一跳 MTU；PP 时为出错字段的字节偏移；echo 时拆为 id + seqno（`struct icmp6_echo_hdr`） |

type 分布（lwIP `enum icmp6_type`）：

- 错误类（0–127）：`DUR=1` destination unreachable、`PTB=2` packet too big、`TE=3` time exceeded、`PP=4` parameter problem、`PE1/PE2=100/101` 私有实验、`127` 错误类扩展保留；
- 信息类（128–255）：`EREQ=128` echo request、`EREP=129` echo reply、`MLQ=130/MLR=131/MLD=132` 组播监听（MLDv2）、`RS=133`/`RA=134` 路由请求/通告、`NS=135`/`NA=136` 邻居请求/通告、`RD=137` 重定向、`MRA=151`/`MRS=152`/`MRT=153` 组播路由、`PE3/PE4=200/201` 私有实验、`255` 信息类扩展保留。

DUR 的 code 空间（`enum icmp6_dur_code`）：0=no route、1=prohibited、2=beyond scope、3=address unreachable、4=port unreachable、5=ingress/egress policy、6=reject route。TE：0=hop limit 超时、1=分片重组超时。PP：0=header 字段错、1=next header 无法识别、2=IPv6 选项无法识别。

### 差错报文限制

- IPv4：差错报文中只回「IP 头 + 最多 8 字节」的原始报文（lwIP `ICMP_DEST_UNREACH_DATASIZE=8`；RFC 792），定位 TCP/UDP 端口即可，不放大流量；
- ICMPv6：尽量多回，但受最小 MTU 约束——lwIP 把可回长度钳制为 `LWIP_ICMP6_DATASIZE`，默认不超过 `IP6_MIN_MTU_LENGTH(1280) − IP6_HLEN(40) − ICMP6_HLEN(8) = 1232` 字节；
- ICMPv4 的校验和只覆盖 ICMP 报文本身；ICMPv6 的校验和覆盖伪头部 + ICMPv6 报文，因此 ICMPv6 在校验前必须先拿到当前包的 src/dest 地址（`ip6_current_src_addr/dest_addr`）。

## 核心机制

### 错误报告（差错生成）

差错响应不是被动收包，而是由 IP 层/传输层在**处理原始报文的当下**主动调用：

- IPv4：`icmp_dest_unreach`（IP 协议号未知、UDP 端口未绑定等）与 `icmp_time_exceeded`（TTL 耗尽/分片重组超时）调用公共发送器 `icmp_send_response`：构造「ICMP 头 + 原始 IP 头 + 最多 8 字节」，把 ICMP 报文发回原始报文的源地址（取 `iphdr->src`，经 `ip4_route` 选接口），TTL 用 `ICMP_TTL`；
- ICMPv6：`icmp6_dest_unreach`、`icmp6_packet_too_big`、`icmp6_time_exceeded`、`icmp6_param_problem` 是四个独立发送函数，统一落到三层发送器：`icmp6_send_response` → `_with_addrs` → `_with_addrs_and_netif`。核心不变量是「**响应必须与被响应报文同上下文**」：直接响应用 `ip6_current_*` 上下文（源地址选择、netif、zone）；延迟响应（如分片重组超时，当前包已不相关）必须由调用方显式传回原始 src/dest 地址及其 zone，lwIP 用 `icmp6_time_exceeded_with_addrs` 专门处理。

### echo（ping）

- IPv4：`icmp_input` 收到 `ICMP_ECHO` 后，若目标为组播/广播则按配置决定是否响应（`LWIP_MULTICAST_PING`/`LWIP_BROADCAST_PING`；默认只对单播响应），随后把 IP 头中的 src/dest 互换、type 改 `ICMP_ER`、增量式更新 ICMP 校验和（把 `8<<8` 的贡献转换掉）、重算 IP 头校验和、TTL 改为 `ICMP_TTL`，经 `ip4_output_if` 发回；
- ICMPv6：`icmp6_input` 收到 `ICMP6_TYPE_EREQ` 后，复制整包、type 改 `ICMP6_TYPE_EREP`、校验和清零并基于伪头部重新计算，经 `ip6_output_if` 发回（响应源地址用 `ip6_select_source_address`，目标为组播时需选择接口地址）。

### PMTU 通知（仅 ICMPv6）

IPv6 路由器不负责分片，报文大于下一跳 MTU 时直接丢弃并回 `ICMP6_TYPE_PTB`，`data` 字段携带下一跳 MTU，源节点据此收缩路径 MTU。lwIP 中 `icmp6_packet_too_big(p, mtu)` 就是这条路径的发送端；接收端对 PTB 的处理不在本模块，而是在 `nd6_input`（见下）。注意 IPv4 的等价物是「需分片但 DF 置位」（DUR code 4），靠源节点自行处理。

### ICMPv6 类型分布与 NDP 分工

ICMPv6 是 IPv6 各类「带外消息」的公共载体，lwIP 的 `icmp6_input` 在入口处就完成分流：

- 邻居发现（NDP，`nd6_input`）：NS/NA/RA/Redirect，以及 **PTB**（lwIP 把 PTB 交给 nd6 处理，见 icmp6.c 的 switch）——PTB 虽在 ICMPv6 框架内，但其消费逻辑（更新路由/目的缓存的 PMTU）归属 NDP 链路层机制；
- 组播监听（MLD，`mld6_input`）：MLQ/MLR/MLD；
- RS：只有开启 `LWIP_IPV6_FORWARD`（路由器功能，lwIP 标注 todo 未实现）才处理，否则静默；
- 其余（EREQ 之外的类型）走 default 分支：只更新统计，丢弃。

所以 ICMPv6 入口 = 「echo 自己处理 + 邻居发现/组播/PTB 转交 + 其余丢弃」三件事。

## 设计取舍

| 维度 | ICMPv4（RFC 792） | ICMPv6（RFC 4443） |
| --- | --- | --- |
| 校验和范围 | 仅 ICMP 报文本体 | 伪头部 + ICMPv6 报文（每包必算，不能增量式调整） |
| 差错报文回带 | IP 头 + 8 字节 | 尽量多，受最小 MTU 限制（lwIP 钳到 1232） |
| 分片/MTU | 路由器可分片；DF 置位超限回 DUR code 4 | 路由器不分片；超限回 PTB 并带 MTU |
| 类型空间 | 平铺的数字（echo=8 等） | 错误类（0–127）/信息类（128–255）结构化 |
| 负载角色 | 仅 ICMP 自己的 echo/差错 | 同时承载 NDP、MLD、PTB 等邻居发现/组播控制消息 |
| 响应源地址 | 直接用收包目标地址（或接口地址） | 需 `ip6_select_source_address` 选择，带 zone |

lwIP 实现层面的取舍：

- IPv4 的 ICMP 入口很「薄」：`icmp_input` 只做 echo 回复和统计，差错发送是几个小函数；ICMPv6 入口则承担了邻居发现/组播的分发，`icmp6.c` 因此在 lwIP 中既像「ICMP 模块」又像「ICMPv6 入口路由器」；
- IPv4 echo 复用收包 pbuf 就地改写（省一次拷贝，需确保 pbuf 有链路头空间，`LWIP_ICMP_ECHO_CHECK_INPUT_PBUF_LEN` 默认开启，空间不足时重新分配）；ICMPv6 echo 直接复制整包再改（`icmp6_input`），实现更直接；
- 差错响应构造遵循「echo 头 + 原始前缀」，把 id/seqno 清零、复用 `struct icmp_echo_hdr`，避免为每种差错定义独立结构。

## 不变量

- **响应与触发包同上下文**：IPv6 差错响应必须在收到原始包的同一时刻发出（用 `ip6_current_*`）；延迟响应必须显式携带原始 src/dest 地址与 zone（`icmp6_time_exceeded_with_addrs`）。丢失 zone 会把 link-local 应答发到错误接口——违反此不变量即产生无法路由的响应。
- **差错不回差错**：ICMP 差错报文本身不再触发新的 ICMP 差错（lwIP 在 IPv4 入口只处理 echo，对差错类报文在 switch 中归入 default 分支统计后丢弃；RFC 4443 §2.4 同旨）。否则差错风暴自激放大。
- **校验和必须覆盖伪头部（ICMPv6）**：`ip6_chksum_pseudo` 的输入（src/dest、Next Header=58、总长）必须与当前报文的 IP 头一致，收包校验为 0、发包重算。
- **差错报文本省与携带前缀之和不超过发送路径 MTU**：IPv4 固定 8 字节；IPv6 钳在 `LWIP_ICMP6_DATASIZE`（≤1232）。
- **echo 响应长度等于请求长度**：lwIP 复制整个请求（含载荷）后只改 type 与校验和，因此响应 echo 的 id/seqno 与请求逐位一致。
- **未配置即丢弃**：组播/广播 ping 在 `LWIP_MULTICAST_PING`/`LWIP_BROADCAST_PING` 未开启时按差错丢弃，避免响应放大（smurf 类反射攻击面）。

## 边界条件与异常处理

- **短报文**：IPv4 检查 IP 头长 ≥ 最小头、ICMP 报文 ≥ 4 字节（`p->len < sizeof(u16_t)*2`）、echo ≥ 8 字节；ICMPv6 检查 `p->len < sizeof(struct icmp6_hdr)`。不满足一律释放 pbuf、统计 `lenerr` 后丢弃。
- **校验和失败**（ICMPv6 必查，IPv4 在 `CHECKSUM_CHECK_ICMP` 下查）：释放、统计 `chkerr`、丢弃。
- **组播/广播 echo**：默认丢弃；开启对应 LWIP 选项时才用接收接口地址作为源地址响应（`LWIP_MULTICAST_PING` 下 ICMPv6 需 `ip6_select_source_address`，选择失败返回 `rterr` 丢弃）。
- **资源不足**：pbuf 分配/拷贝失败 → 释放所有已分配 pbuf、统计 `memerr`/`err`、丢弃，绝不泄漏。IPv4 echo 若原 pbuf 放不下链路头，重新分配整包拷贝，失败即丢弃。
- **路由不可用**：IPv4 `ip4_route` 返回 NULL 时**不发**差错（不统计 xmit）；ICMPv6 源地址选择/路由失败时统计 `rterr` 并丢弃——差错响应自身无法路由时宁可静默。
- **无法识别的 type/code**：IPv4 在 default 分支按 type 累加 MIB2 统计后丢弃（`proterr`/`drop`），不再构造任何应答；ICMPv6 除已知分发外全部统计后丢弃。
- **速率/放大防护**：差错响应只带原始前缀（IPv4 8 字节、IPv6 ≤1232），且受路由/源地址选择失败即静默约束；这是「差错不回差错 + 前缀限制 + 组播默认不响应」三层防反射放大设计的一部分。