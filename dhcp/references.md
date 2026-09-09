# DHCP · references

## 规范 / 标准

| 文档 | 内容 | 阅读用途 |
| --- | --- | --- |
| RFC 951 | BOOTP（DHCPv4 的报文格式来源） | wire format 的历史背景 |
| RFC 2131 | Dynamic Host Configuration Protocol（DHCPv4） | 客户端状态机、DORA、租约、T1/T2/T0 |
| RFC 2132 | DHCP Options and BOOTP Vendor Extensions | option 语义（1/3/6/50/51/53/54/55/57/58/59…） |
| RFC 3315 | Dynamic Host Configuration Protocol for IPv6 (DHCPv6) | DUID、IA_NA、SARR、无状态/有状态 |
| RFC 3736 | Stateless DHCPv6 | 无状态参数下发（lwIP `dhcp6.c` 的主要依据） |
| RFC 3927 | Dynamic Configuration of IPv4 Link-Local Addresses | 与 AUTOIP 协作（`LWIP_DHCP_AUTOIP_COOP`） |
| RFC 1541 / 3006 等 | DHCP 补充选项 | 扩展 option 时按需查阅 |

## 论文

暂无特别推荐的论文；DHCP 的机制理解以 RFC 与源码对照为主。若需追溯设计动机，可读 RFC 2131 前言（对 BOOTP 局限性的讨论）与 RFC 3315 的设计目标章节。

## 上游仓库（固定版本 / commit）

| 项目 | 仓库 | 固定版本 / commit | 用途 |
| --- | --- | --- | --- |
| lwIP | github: lwIP-tcpip/lwip | `STABLE-2_1_3_RELEASE` = commit `6ca936f6b588cee702c638eee75c2436e6cf75de` | 主实现（客户端） |

- 上表 commit 对应 git tag `STABLE-2_1_3_RELEASE`。
- 源码复制范围与文件清单见 `src/README.md`；对上游文件的改动仅限学习注释，不改变控制流。

## 其他实现

| 实现 | 仓库 | 对照价值 |
| --- | --- | --- |
| ISC DHCP（kea） | github: isc-projects/kea（旧 ISC DHCP 的分支演进） | 服务器侧：地址池、租约数据库、冲突检测、中继（`server/dhcpd.c`） |
| dnsmasq | thekelleys.org.uk/dnsmasq（官网 tarball 或发行版源码） | 轻量服务器：地址池分配、静态绑定、与 DNS 集成（`src/dhcp.c`） |
| ISC dhcp-client / BusyBox udhcpc | 各发行版源码 | 另一个客户端实现，对照 `dhcp.c` 的状态机取舍 |

> 注：服务器侧实现仅作对照阅读，不复制其源码（本模块主实现为 lwIP 客户端）。

## 阅读备注

- **客户端为主**：lwIP `dhcp.c` 是完整的客户端状态机，适合一条闭环读到底；`dhcp6.c` 只覆盖无状态，读时对照 RFC 3736 与 3315 的差异。
- **服务器侧补充**：要理解「为什么客户端这样设计」，必须补看服务器如何分配/回收地址（ISC DHCP / dnsmasq），尤其租约到期回收与地址冲突检测。
- **定时器是第二主角**：`dhcp_fine_tmr`（500ms）与 `dhcp_coarse_tmr`（60s）是状态机的心跳；`tries` 计数与指数退避共同构成无状态 UDP 上的可靠性。
- **对照 TCP**：同样面对丢包，TCP 用窗口 + ACK，DHCP 用应用层重传 + 状态机——思考两者适用场景的差异。
- **DHCPv6 缺口**：lwIP 的 `dhcp6_enable_stateful` 未实现（返回 `ERR_VAL`）；有状态 DHCPv6（IA_NA、DAD、租约）需结合 RFC 3315 与 ISC/DHCPv6 服务器补充理解。
- **观察记录**：若有抓包，按 §3 规范放 `observations.md`，并回链到对应源码函数。