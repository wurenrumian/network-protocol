# IPv4 / IPv6 · references

## 规范 / 标准

- **RFC 791** — Internet Protocol（IPv4 规范：头、分片、TTL、校验和）。
  <https://www.rfc-editor.org/rfc/rfc791>
- **RFC 8200** — Internet Protocol, Version 6 (IPv6) Specification（固定头、扩展头链、分片、No Next Header/未知头处理）。
  <https://www.rfc-editor.org/rfc/rfc8200>
- **RFC 8201** — Path MTU Discovery for IP version 6（PMTU 发现，配合 RFC 1191 IPv4 的对应机制）。
  <https://www.rfc-editor.org/rfc/rfc8201>
- **RFC 4291** — IP Version 6 Addressing Architecture（IPv6 地址模型、前缀、接口标识、组播地址结构）。
  <https://www.rfc-editor.org/rfc/rfc4291>
- **RFC 1122 / 1123** — Requirements for IP Hosts（IPv4 主机语义：转发、收发、分片、差错处理）。
  <https://www.rfc-editor.org/rfc/rfc1122> / <https://www.rfc-editor.org/rfc/rfc1123>
- 可选扩展阅读：RFC 4861（邻居发现依赖）、RFC 2474（DSCP）、RFC 2986/3168（ECN）、RFC 6147 / 6052（NAT64、IPv4-in-IPv6 封装）。

## 论文

- V. Jacobson 关于 PMTU 与高速网络的经典讨论（RFC 1191 的背景）；如需更深入可读 IAB/互联网体系结构综述。
- lwIP 设计相关：*Adam Dunkels, Design and Implementation of the lwIP TCP/IP Stack*（涉及 netif/内存/无状态转发设计，可解释本模块的模块边界）。

## 上游仓库（固定版本 / commit）

- 主实现：**lwIP**，仓库 `https://github.com/lwIP-tcpip/lwip`
  - tag：`STABLE-2_1_3_RELEASE`
  - commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
  - 本模块复制入 `src/` 的文件与来源见 `src/README.md`；许可证为 BSD-3-Clause，见 `src/LICENSES/COPYING`。
  - 注意：本模块固定 lwIP 2.1.3（2.1.x 系列为 STABLE/长期支持分支；2.2.0 开始并入新 API）。后续若有升级需要，先复核上表与 `src/README.md` 中的函数名（如 `ip4_input`）。

## 其他实现

- **Linux 内核协议栈**（对照）：`net/ipv4/ip_forward.c`（转发、选路）与 `net/ipv6/ip6_input.c` 收包路径；`ip6_fragment()` 对应源端分片；重点对比 lwIP 的「无多接口重组」、「不实现灰度扩展头」与内核做法。
- **FreeRTOS+TCP / Zephyr net stack**：与 lwIP 同族嵌入式栈，用于比较 netif 抽象与内存策略。
- **uIP / Contiki**：lwIP 前身模块的微型化，观察「最小实现」如何取舍 IPv6 扩展头。

## 阅读备注

- 先读 `prot/ip.h` `prot/ip4.h` `prot/ip6.h` 三份结构头，与 RFC 字段逐列对照，避免在实现里迷失。
- IPv4 的 `ip_input`（对 IHL>最小头的包在 `ip4_input` 内做选项拒绝检查、分片重组）与 IPv6 的 `ip6_input`（扩展头遍历 + 分片扩展头内联重组）是核心，先读入，再读 `ip_output` 一侧。
- 推荐三个真实场景驱动：① 构造超大 UDP 包看分片；② 发送 DF=1 超 MTU 包看 ICMP Fragmentation Needed；③ 设 TTL/Hop Limit 过小看 Time Exceeded。用 `tcpdump`/Wireshark 对照 `ip4.c`/`ip6.c` 中的丢弃分支。
- lwIP 对 IPv6 扩展头「只实现分片、其他直接丢弃」是本模块最有讨论价值的设计取舍，阅读时专门记笔记：为什么可以这样，影响是什么（安全：无未知头回应，DoS 面小）。
- IPv4 头校验在 `ip4.c` 的 `ip4_input` 中通过 `inet_chksum(iphdr, iphdr_hlen)` 完成，校验失败即丢弃（`ip4.c:497` 附近）；IPv6 无头校验，注意对比上层伪头校验的承担方（TCP/UDP/ICMPv6 的伪头校验）。
- 分片发送逻辑（`ip4_frag` / `ip6_frag`）位于 `src/core/ipv4/ip4_frag.c` 与 `src/core/ipv6/ip6_frag.c`，本模块未复制，见 `src/README.md` 未复制依赖一节。