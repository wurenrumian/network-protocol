# UDP · src

本页是 UDP 模块源码的导航页，不复述协议内容（见 `protocol.md`、`state-machine.md`）。

## 上游版本

- 仓库：github.com/lwIP-tcpip/lwip
- 版本 / tag：`STABLE-2_1_3_RELEASE`（lwIP 2.1.3）
- commit：`6ca936f6b588cee702c638eee75c2436e6cf75de`
- 许可证：`../LICENSES/COPYING`（BSD-3-Clause，lwIP 上游版权声明）。

源码保留上游原始相对路径，直接复制，未改动控制流；学习注释可加在 `src/upstream/` 副本上。

## 文件清单（文件 → 类别 → 阅读范围）

| 文件（相对 `src/upstream/`） | 类别 | 阅读范围 |
| --- | --- | --- |
| `src/include/lwip/prot/udp.h` | core（wire format） | 全文：`udp_hdr` 8 字节头定义，`UDPH_*` 宏 |
| `src/include/lwip/udp.h` | core（抽象对象） | 全文：`struct udp_pcb`、`udp_pcbs` 链表、API 原型（bind/connect/sendto/input 等） |
| `src/core/udp.c` | core（机制） | 全文：端口表、`udp_input` 内端口查找与复用、`udp_input` 收包、`udp_sendto`/`udp_send` 发包、校验 |

三个文件全部复制，无裁剪。`src/core/udp.c` 中部分函数依赖 IP 层（`ip4_output_if`/`ip6_output_if`）与 `ip4_input`/`ip6_input` 的分发，属 integration 边界，仅在追踪调用链时按需参考，不复制相关文件。

## 阅读顺序与调用链

```text
1. src/include/lwip/prot/udp.h    wire format（udp_hdr）
2. src/include/lwip/udp.h         PCB 结构与 API 原型
3. src/core/udp.c                 端口查找/复用、收/发主路径
```

推荐主闭环为「收包分发」：

```text
ip4_input / ip6_input（integration，未复制）
  → udp_input            （解析头、长度检查、遍历 udp_pcbs 查找、校验）
  → recv 回调             （载荷上抛给上层）
```

辅助闭环「发送」：

```text
udp_sendto / udp_send
  → 校验目的地址与端口
  → 伪头校验和
  → 构造 udp_hdr + pbuf
  → ip4_output_if / ip6_output_if（integration，未复制）
```

## 入口函数 / 结束函数

- **入口**：
  - `udp_input`（收包，`src/core/udp.c`，由 IP 层按协议号 17 调用）
  - `udp_sendto` / `udp_send`（发包）
  - `udp_bind` / `udp_connect` / `udp_new` / `udp_remove`（PCB 生命周期）
- **结束**：
  - 收包：`recv` 回调返回（载荷已上抛），或丢弃返回
  - 发包：`ip4_output_if` / `ip6_output_if` 返回（进入 IP 层）
  - 生命周期：`udp_remove` 释放 PCB

## 未复制的依赖

UDP 核心依赖但未复制的文件（不在本模块闭环内，需在 IP 模块阅读）：

- `src/core/inet_chksum.c`：`inet_chksum_pseudo`（IPv4 伪头校验和）
- `src/core/ip6.c` / `ip6_addr`：`ip6_chksum_pseudo`（IPv6 伪头校验和）
- `src/core/ip4.c` / `ip6.c`：`ip4_output_if` / `ip6_output_if`（IP 层发送）
- `src/core/ip.c`：`ip4_input` / `ip6_input`（按 protocol 分发到 `udp_input`）
- `src/core/def.c`、`src/core/mem.c`、`src/core/pbuf.c`：字节序、内存、pbuf 缓冲等通用基础
- `src/include/lwip/err.h`、`src/include/lwip/ip_addr.h` 等头文件：类型与错误码定义
- `src/core/stats.c`：`lwip_stats` 统计计数

## 已复制 / 跳过说明

- **已复制**：`src/core/udp.c`、`src/include/lwip/udp.h`、`src/include/lwip/prot/udp.h`，对应上游原始路径，全部完整保留。
- **跳过**：UDP 相关的 `inet_chksum`、IP 层收发、socket/BSD API（`src/api/`）、`netconn`、pbuf 与内存等，均属 integration/platform 或通用依赖，仅按需对照，不在本模块复制。
- 三个 URL 全部成功下载（200），无 404 跳过项。