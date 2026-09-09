# ICMP · state-machine

## 状态

ICMP / ICMPv6 **没有显式协议状态**：它不维护连接、没有会话表，收发之间唯一的「状态」是收包时的 IP 层上下文（源/目的地址、netif、zone）与配置开关。因此本文件记录的是处理流程（无显式状态机时的流程记录）。

可视为「隐式状态」的只有三类：

1. **配置开关**（编译期/`lwipopts.h`/netif 标志）：`LWIP_MULTICAST_PING`、`LWIP_BROADCAST_PING`、`CHECKSUM_CHECK_ICMP(_6)`、`CHECKSUM_GEN_ICMP(_6)`、`NETIF_CHECKSUM_CHECK/GEN_ICMP(_6)`、`LWIP_ICMP6_DATASIZE`；
2. **接收上下文**：`ip4_current_*` / `ip6_current_*`（当前正在处理的 IP 报文的地址、netif、zone），由 IP 层在调用 `icmp_input`/`icmp6_input` 前设置，差错响应依赖它；它是隐式状态而非协议状态；
3. **统计计数器**（MIB2 / ICMP_STATS）：`recv`、`chkerr`、`lenerr`、`proterr`、`drop`、`memerr`、`rterr`、`xmit`、`err` 等，不参与协议决策。

## 事件

- **收包事件**：`ip_input`/`ip6_input` 把 Next Header = ICMP(1) / ICMPv6(58) 的报文连同 netif 交给 `icmp_input` / `icmp6_input`。这是唯一的外部输入事件。
- **发错包事件**（差错生成的触发点，均发生在「正在处理某个原始报文」的当下）：
  - IPv4：IP 协议号未知、UDP 端口未绑定 → `icmp_dest_unreach`；TTL 耗尽/分片重组超时 → `icmp_time_exceeded`；
  - IPv6：`icmp6_dest_unreach`（端口/地址不可达等）、`icmp6_packet_too_big`（超 MTU）、`icmp6_time_exceeded`（hop limit 耗尽/重组超时）、`icmp6_param_problem`（字段错误）。
- **内部事件**：无定时器、无重传、无超时重发。

## 状态转移

无连接、无状态转移。报文生命期等价于「输入 → 类型分发 → 输出或丢弃」的一次性映射，收一个报文最多产生一个响应，且响应后该报文的全部资源（pbuf）即被释放。

## 正常 / 异常时序

### IPv4 echo 正常时序

```text
ip_input
  → icmp_input(p, netif)                icmp.c:80
      ├─ 校验 IP 头长 ≥ 20、ICMP ≥ 4 字节
      ├─ switch(type)：
      │    ICMP_ECHO:
      │      ├─ 目的为组播/广播？按 LWIP_MULTICAST/BROADCAST_PING 决定响应或丢弃
      │      ├─ 校验 ICMP 校验和（CHECKSUM_CHECK_ICMP）为 0
      │      ├─ 确保 pbuf 能容纳链路头（否则重新分配拷贝）
      │      ├─ 互换 IP 头 src/dest、type → ICMP_ER、增量更新校验和、TTL → ICMP_TTL
      │      └─ ip4_output_if(...) 发回            icmp.c:250
      └─ pbuf_free(p)
```

### IPv6 echo 正常时序

```text
ip6_input
  → icmp6_input(p, netif)               icmp6.c:83
      ├─ 校验 ICMPv6 头 ≥ 8 字节
      ├─ 伪头部校验和 = 0（CHECKSUM_CHECK_ICMP6）
      ├─ switch(type)：
      │    ICMP6_TYPE_EREQ:
      │      ├─ 组播目标？LWIP_MULTICAST_PING 关闭则丢弃
      │      ├─ pbuf_alloc + pbuf_copy 复制整包
      │      ├─ type → ICMP6_TYPE_EREP；源地址 = ip6_select_source_address（组播时）
      │      ├─ 校验和清零，ip6_chksum_pseudo 重算
      │      └─ ip6_output_if(...) 发回            icmp6.c:194
      └─ pbuf_free(p)
```

### ICMPv6 类型分发（含 NDP 分工）

```text
icmp6_input
  ├─ ICMP6_TYPE_NS/NA/RA/RD/PTB → nd6_input(p, inp)   icmp6.c:121
  ├─ ICMP6_TYPE_RS → 仅 LWIP_IPV6_FORWARD 时考虑（lwIP 未实现，静默）
  ├─ ICMP6_TYPE_MLQ/MLR/MLD → mld6_input(p, inp)          icmp6.c:132
  ├─ ICMP6_TYPE_EREQ → echo reply（见上）
  └─ default → 统计 proterr/drop，丢弃
```

### IPv4 差错生成时序（由上层在收包当下调用）

```text
udp_input / ip_input 处理出错
  → icmp_dest_unreach(p, t)             icmp.c:308
      └─ icmp_send_response(p, ICMP_DUR, t)   icmp.c:340
           ├─ 回带长度 = min(p->tot_len, IP_HLEN+8)
           ├─ 构造「echo 头(type/code, id/seqno=0) + 原始前缀」
           ├─ ip4_route(原始 src) 选接口；无路由则静默（不统计 xmit）
           ├─ 计算 ICMP 校验和
           └─ ip4_output_if(...) 发出            icmp.c:405
```

### IPv6 差错生成时序（直接响应 vs 延迟响应）

```text
直接响应（仍在处理原始包）：
  icmp6_dest_unreach / icmp6_packet_too_big / icmp6_time_exceeded / icmp6_param_problem
    → icmp6_send_response(p, code, data, type)          icmp6.c:309
         ├─ 断言 netif != NULL（必须是直接响应）
         ├─ reply_dest = ip6_current_src_addr()
         ├─ reply_src = ip6_select_source_address(...)；失败 → rterr 丢弃
         └─ _with_addrs_and_netif 发出                   icmp6.c:385

延迟响应（如分片重组超时，原始包上下文已失效）：
  调用方显式传回原始 src/dest 地址（含 zone）
  → icmp6_time_exceeded_with_addrs(p, c, src, dst)       icmp6.c:273
    → icmp6_send_response_with_addrs(...)                icmp6.c:346
         ├─ 断言 src/dest 均非 NULL
         ├─ 交换 src/dest 作为应答方向
         ├─ ip6_route(reply_src, reply_dest)；失败 → rterr 丢弃
         └─ _with_addrs_and_netif 发出
```

## 处理流程（无显式状态机时）

- **入口函数**：`icmp_input`（IPv4，icmp.c:80）、`icmp6_input`（IPv6，icmp6.c:83），均由 IP 层在 `ip_input`/`ip6_input` 内按 Next Header 分发调用；
- **出口函数**：`icmp_dest_unreach`、`icmp_time_exceeded`（IPv4，icmp.c:308/323）；`icmp6_dest_unreach`、`icmp6_packet_too_big`、`icmp6_time_exceeded`、`icmp6_time_exceeded_with_addrs`、`icmp6_param_problem`（IPv6，icmp6.c:220–292）；
- **闭环形态**：一条真实路径从 `ip_input`/`ip6_input` 进入，经 ICMP 类型分发（echo 就地应答 / 差错经 `icmp*_send_response*` 构造新报文 / 邻居发现与组播经 `nd6_input`/`mld6_input` 转交），最后经 `ip4_output_if`/`ip6_output_if` 送回网络层出口。整条路径无定时器、无队列、无状态留存，pbuf 在出口处一律释放，异常分支（短报文、校验失败、内存不足、无路由）均以「释放 + 统计 + 丢弃」结束。