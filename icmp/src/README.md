# ICMP · src

## 上游版本

- 仓库：`github.com/lwIP-tcpip/lwip`
- tag：`STABLE-2_1_3_RELEASE`
- commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：`src/LICENSES/COPYING`（BSD-3-Clause 风格；`icmp.c`、`icmp6.c`、两个头文件内另有作者版权声明：icmp.c/icmp.h/icmp6.h 为 Swedish Institute of Computer Science，icmp6.c 为 Inico Technologies Ltd.）
- 下载方式：curl 从 `https://raw.githubusercontent.com/lwIP-tcpip/lwip/STABLE-2_1_3_RELEASE/<path>` 逐文件获取，全部成功，无 404。

## 文件清单（文件 → 类别 → 阅读范围）

| 上游原始路径 | 本地路径（`src/upstream/` 下） | 类别 | 阅读范围 |
| --- | --- | --- | --- |
| `src/include/lwip/prot/icmp.h` | `src/include/lwip/prot/icmp.h` | core | 全读：`struct icmp_echo_hdr`、type/code 常量（ICMP_ER/DUR/SQ/RD/ECHO/TE/PP/TS/TSR/IRQ/IR/AM/AMR） |
| `src/include/lwip/prot/icmp6.h` | `src/include/lwip/prot/icmp6.h` | core | 全读：`enum icmp6_type`、`icmp6_dur_code`、`icmp6_te_code`、`icmp6_pp_code`、`struct icmp6_hdr`、`struct icmp6_echo_hdr`、`ICMP6_HLEN` |
| `src/core/ipv4/icmp.c` | `src/core/ipv4/icmp.c` | core | 全读：`icmp_input`（icmp.c:80）、`icmp_dest_unreach`（:308）、`icmp_time_exceeded`（:323）、`icmp_send_response`（:340）；文件头注释 icmp.c:39-40（差错不传给传输层） |
| `src/core/ipv6/icmp6.c` | `src/core/ipv6/icmp6.c` | core（含 integration 边界：向 `nd6_input`/`mld6_input` 的转交） | 全读：`icmp6_input`（icmp6.c:83）、四个差错发送函数（:220/:236/:252/:292）、`icmp6_time_exceeded_with_addrs`（:273）、三层私有发送器（:309/:346/:385） |

说明：四个文件均属 `core/`（协议本身）。`icmp6.c` 同时是 ICMPv6 入口路由器，把邻居发现/组播消息转交 `nd6_input`/`mld6_input`——该分流属于 `core/` 与邻居发现（integration）的边界，阅读时只关注分流点，不深入 nd6/mld6 内部。

## 阅读顺序与调用链

1. `src/include/lwip/prot/icmp.h`、`icmp6.h`：报文结构（8 字节 ICMP/ICMPv6 头、echo 变体、type/code 常量、ICMPv6 错误/信息类型空间）
2. `src/core/ipv4/icmp.c`：先 `icmp_input`（入口）→ `icmp_send_response`/`icmp_dest_unreach`/`icmp_time_exceeded`（出口）
3. `src/core/ipv6/icmp6.c`：先 `icmp6_input`（入口 + 类型分发）→ 四个差错发送函数 → 私有发送器三层

调用链（收包路径）：

```text
ip_input / ip6_input
  → icmp_input(p, netif) / icmp6_input(p, netif)
      → [echo] ip4_output_if / ip6_output_if（经 IP 层发回）
      → [ICMPv6 NDP/PTB] nd6_input(p, netif)
      → [ICMPv6 MLD] mld6_input(p, netif)
      → [其余] 统计 + 丢弃
```

调用链（发错包路径，由上层在处理原始报文当下调用）：

```text
udp_input / ip_input 出错
  → icmp_dest_unreach / icmp_time_exceeded
      → icmp_send_response → ip4_output_if

ip6_input / ip6_reass 出错
  → icmp6_dest_unreach / icmp6_packet_too_big / icmp6_time_exceeded(_with_addrs) / icmp6_param_problem
      → icmp6_send_response(_with_addrs(_and_netif)) → ip6_output_if
```

## 入口函数 / 结束函数

- **入口**：`icmp_input(struct pbuf *p, struct netif *inp)`（icmp.c:80）；`icmp6_input(struct pbuf *p, struct netif *inp)`（icmp6.c:83）
- **结束（出口）**：
  - IPv4：`icmp_dest_unreach`（icmp.c:308）、`icmp_time_exceeded`（icmp.c:323）——两者最终都经私有 `icmp_send_response`（icmp.c:340）把差错报文交给 `ip4_output_if`；
  - IPv6：`icmp6_dest_unreach`（icmp6.c:220）、`icmp6_packet_too_big`（:236）、`icmp6_time_exceeded`（:252）、`icmp6_time_exceeded_with_addrs`（:273）、`icmp6_param_problem`（:292）——最终都经私有三层 `icmp6_send_response` → `_with_addrs` → `_with_addrs_and_netif`（:309/:346/:385）交给 `ip6_output_if`。
- 注意：`icmp_input`/`icmp6_input` 中 echo 应答也以 `ip4_output_if`/`ip6_output_if` 结束；`ip4_output_if`/`ip6_output_if` 在 `src/core/ipv4/ip4.c`、`src/core/ipv6/ip6.c` 中（未复制，见下）。

## 未复制的依赖

以下为 lwIP 中本模块运行所依赖、但未复制到 `src/upstream/` 的文件（与闭环无关或属其他模块职责，在阅读时沿调用链跳转）：

- `src/include/lwip/ip.h`、`src/include/lwip/ip6.h`、`src/include/lwip/ip4.h`：`ip4_current_header`、`ip4_current_src_addr/dest_addr`、`ip6_current_*`、`ip6_select_source_address` 等当前报文上下文 API；
- `src/core/ipv4/ip4.c`：`ip4_output_if`、`ip4_route`、`ip_input`（分发入口）；
- `src/core/ipv6/ip6.c`：`ip6_output_if`、`ip6_route`、`ip6_input`（分发入口）；
- `src/core/ipv6/nd6.c`：`nd6_input`（NS/NA/RA/RD/PTB 的消费方，邻居发现模块）；
- `src/core/ipv6/mld6.c`：`mld6_input`（MLQ/MLR/MLD 的消费方，组播监听模块）；
- `src/include/lwip/pbuf.h`、`src/core/pbuf.c`：`pbuf_alloc`、`pbuf_copy`、`pbuf_add_header/remove_header`、`pbuf_take_at`、`pbuf_free`；
- `src/include/lwip/inet_chksum.h`、`src/core/inet_chksum.c`：`inet_chksum`、`inet_chksum_pbuf`、`ip6_chksum_pseudo`（伪头部校验）；
- `src/include/lwip/arch.h`、`src/include/lwip/def.h`、`src/include/lwip/opt.h`、`src/include/lwip/stats.h`、`src/include/lwip/netif.h`：基础类型、字节序宏、配置开关、统计与 netif 结构（含 `NETIF_CHECKSUM_*` 标志）；
- `src/include/lwip/icmp.h`、`src/include/lwip/icmp6.h`（注意：`icmp6.c` 同时 include `lwip/icmp6.h` 与 `lwip/prot/icmp6.h`，前者为 lwip 公共 API 层，后者为协议结构定义——本模块复制的是 `lwip/prot/` 下两个文件）。

## 已复制 / 跳过说明

- **已复制（4 个文件 + 许可证）**：`src/core/ipv4/icmp.c`、`src/core/ipv6/icmp6.c`、`src/include/lwip/prot/icmp.h`、`src/include/lwip/prot/icmp6.h`，以及 `LICENSES/COPYING`。全部来自 lwIP `STABLE-2_1_3_RELEASE`，保留原始相对路径，未改动控制流与命名；可在副本上加学习注释（格式见 `protocol-learning-design.md` §3）。
- **跳过（不复制）**：本模块不依赖 IPv4/IPv6 主处理文件（`ip4.c`/`ip6.c`）、NDP（`nd6.c`）、MLD（`mld6.c`）、pbuf/校验和/基础类型等，它们属于相邻模块或通用基础设施；`src/core/ipv4/icmp.c` 引用的 `lwip/icmp.h`（公共 API）与 `lwip/prot/icmp.h`（协议结构）不同，前者未复制，阅读时按 include 链跳转。
- **勘误记录**：`icmp6.c` 头注释「as per RFC 4443」按上游原样保留；规范编号勘误见 `references.md`（RFC 4443 编号沿用旧编号，现行编号已更新）。