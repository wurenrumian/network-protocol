# DNS · references

## 规范 / 标准

| RFC | 标题 | 本模块用途 |
|---|---|---|
| RFC 1034 | DOMAIN NAMES - CONCEPTS AND FACILITIES | 域名空间、委派模型、**Resolver Algorithm（§4.3.2）**、TTL 语义 |
| RFC 1035 | DOMAIN NAMES - IMPLEMENTATION AND SPECIFICATION | **wire format**：头/四段、name 压缩、类型/类、RR 编码 |
| RFC 2308 | Negative Caching of DNS Responses | 负缓存（NXDOMAIN/NODATA，SOA 负 TTL） |
| RFC 4033 | DNS Security Introduction and Requirements | DNSSEC 动机与模型（完整性、无真实性证明） |
| RFC 4034 | Resource Records for the DNS Security Extensions | DNSKEY/DS/RRSIG/NSEC 记录格式 |
| RFC 4035 | Protocol Modifications for the DNS Security Extensions | 验证算法、DO/CD/AD 位语义、信任链 |
| RFC 5155 | DNS Security (DNSSEC) Hashed Authenticated Denial of Existence | NSEC3 及其 opt-out |
| RFC 6891 | Extension Mechanisms for DNS (EDNS) | EDNS0/OPT 伪记录、UDP 大小协商、ext-rcode |
| RFC 9156 | DNS Query Name Minimisation to Improve Privacy | QNAME minimization 算法与限值 |
| RFC 9210 / RFC 9211 | DNS-Transport Privacy（DoT） | 传输层安全上下文，非本模块闭环主体 |
| RFC 9346 | DNS Zone Transfer over TLS（XoT） | 未覆盖，仅在"未复制依赖"中提及 TLS 化传输 |

## 论文

- **Dan Kaminsky, "It's the End of the Cache As We Know It"（2008）**：DNS 缓存投毒（ID 猜测 + 权威伪造）攻击，解释随机 ID / 0x20 随机化 / DNSSEC 的动机。
- **L. Zhu et al., "Connection-Oriented DNS"（IETF Draft, 2020）**：DNS 传输层的取舍背景。
- **RFC 3226（2002）DNSSEC 与 IPv6 A6 感知的消息大小**：可查背景，非必须。
- **dnscache / djbdns 与 "DNS 安全库投毒" 类文章**：历史对比，了解为什么 resolver 要 scrub 应答。

> 说明：以上论文仅作动机背景，不参与本模块闭环；闭环事实以 RFC 1034/1035 与 Unbound 源码为准。

## 上游仓库（固定版本 / commit）

- 主实现：**Unbound** — `https://github.com/NLnetLabs/unbound`
  - tag：`release-1.17.0`
  - 固定 commit：`d25e0cd9b0545ff13120430c94326ceaf14b074f`（对应 tag 的 HEAD）
  - 许可证：BSD-3-Clause（`LICENSE`，已复制至 `src/LICENSES/`）
  - 已复制源码目录与路径：见 `src/README.md` 文件清单；原路径即 `src/upstream/` 下的相对路径。
- 对照实现：
  - **BIND9**（ISC）— `https://gitlab.isc.org/isc-projects/bind9`，主要对照权威/递归双模式与 DNSSEC 工具链。
  - **c-ares**（异步 stub 解析库）— `https://github.com/c-ares/c-ares`，对照"stub resolver 与 recursive resolver 的分工"。

## 其他实现

- **djbdns / tinydns**：极简权威实现，对比"做最少的正确解析"。
- **dnsmasq**：本地缓存 + 转发型 resolver，对比"最小缓存转发的取舍"。
- **PowerDNS recursor / Kraken**：与 Unbound 同类的现代递归器，可对比状态机与缓存结构。
- **tcpdump / Wireshark** 的 DNS dissector：观察 wire format 的对照工具。

## 阅读备注

- **固定版本方式**：上游文件直接从 `raw.githubusercontent.com/NLnetLabs/unbound/release-1.17.0/<path>` 下载，保留原相对路径；commit `d25e0cd9` 用于精确定位。
- **已复制文件的口径**（均为 `core/` 或 `integration/`）：
  - `util/data/msgparse.c`、`util/data/packed_rrset.c`：wire 解析与内存表示（core）；
  - `services/cache/dns.c`、`services/cache/rrset.c`：消息/RRset 缓存（core）；
  - `iterator/iterator.c`、`iterator/iter_hints.c`：迭代状态机与 root hints（core）；
  - `daemon/worker.c`：请求入口、缓存命中外发、EDNS 解析、上游应答回调（integration，连接 socket 事件循环与 iterator）。
- **未复制但被这些文件依赖**（见 `src/README.md`「未复制的依赖」）：validator、outside_network、mesh、slabhash/lruhash、sldns（buffer/wire 工具）、infra cache、neg cache、authzone/localzone/respip 等。阅读时可从 `src/README.md` 的入口函数沿调用链补看，不要求复制。
- **对照观察点**：
  - BIND 的 `lib/dns/resolver.c` 与 Unbound `iterator.c` 的迭代差异：BIND 无显式状态枚举、用大量 goto/分支，Unbound 状态机更适合教学闭环；
  - c-ares 无迭代状态机（依赖上游 recursive resolver），印证"stub vs recursive"的分工边界。
- **学习注释纪律**：只在 `src/upstream/` 副本上添加注释，不修改上游控制流；确需修正时另加补丁并在本文件说明。当前未引入任何补丁。