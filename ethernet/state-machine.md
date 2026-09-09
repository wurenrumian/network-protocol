# Ethernet / 802.3 链路层 · state-machine

## 状态

链路层**没有显式状态机**。以太网帧的传输是无状态的：一帧的发送不依赖前一帧的接收，节点不维护「连接」「会话」这类状态。状态由链路本身和节点生命周期提供：

| 状态 | 所在层 | 说明 |
| --- | --- | --- |
| 链路 up / link up / down | netif（`netif_set_up/down`、`netif_set_link_up/down`） | 驱动/平台层反映物理介质与接口可用性 |
| 接口是否配置（有 IP、MAC 非零） | netif 配置 | 决定能否参与收发 |
| pbuf 引用计数 | pbuf 层 | 决定头部能否移动（剥头可行性） |
| 上层状态（ARP 缓存、IP 路由） | 上层 | 决定下一跳 MAC 如何解析，从而影响帧的 dest |

`ethernet.c` 本身没有任何内部状态：`ethernet_input` / `ethernet_output` 都是纯函数式的——给定帧或 pbuf，直接处理完返回。需要记录状态的机制（ARP 缓存、IP 邻居）都在上层。

## 事件

- `netif_input(p, netif)`：驱动收到一帧。
- `ethernet_output(netif, p, ipaddr, ip6addr)`：上层请求发送一帧。
- `netif_set_up/down`、`netif_set_link_up/down`：接口/链路状态变化。
- `netif_remove`、`netif_set_default`：接口生命周期事件。
- 无定时器事件属于链路层（重传/超时都在上层；链路层也不需要）。

## 状态转移

链路层无状态 → 无状态转移表。可记录的转移仅发生在 netif 生命周期（`netif.c`）：

```text
未添加 → netif_add() → 已添加（未 up）
已添加 → netif_set_up() → up
up → netif_set_down() → down
已添加 → netif_remove() → 移除
link down → netif_set_link_up() → link up（物理恢复）
```

这些转移不改变以太网帧的发送/接收语义，只改变 netif 的可用性与驱动是否交付帧。

## 正常 / 异常时序

### 正常收包时序

```text
物理介质 → 网卡（校验 FCS）→ 驱动回调
→ netif_input(p, netif)                      [platform]
→ ethernet_input(p, netif)                   [core：帧解析]
→ 剥掉 eth_hdr（pbuf_header）
→ 按 EtherType 分发：
     ip4_input / ip6_input / etharp_input
```

### 正常发包时序

```text
上层（IP/ARP）确定下一跳 MAC
→ ethernet_output(netif, p, ip4, ip6)        [core：帧封装]
→ pbuf_header 预留 14 字节 + 填充 dest/src/type
→ netif->linkoutput(netif, p)                [platform：驱动发送，硬件加 FCS]
```

### 异常时序

| 场景 | 位置 | 处理 |
| --- | --- | --- |
| 帧长不足 14 字节 | `ethernet_input` | 直接丢弃（`pbuf_free`） |
| 未知 EtherType | `ethernet_input` | `proterr`+`drop` 统计，丢弃；hook 可接管 |
| pbuf 不可移动（引用计数>1） | 剥头处 | 报「Can't move over header」丢弃，不部分剥除 |
| `pbuf_header` 无空间（发包） | `ethernet_output` | 报错返回，帧未发送 |
| 驱动 FCS 校验失败 | 网卡/驱动 | 驱动处丢弃，协议栈不可见 |
| 接口 down | 驱动/上层 | 不收不发；`netif_issue_reports` 在 up 时补发 gratuitous ARP / IGMP |

## 处理流程（无显式状态机时）

链路层的「状态机」实为两条无状态的处理流水线，见 `state-machine.md` 的时序：

**收包 → 解析 → 分发**：`ethernet_input` 是唯一的帧级入口。它做三件事：长度检查、读取并翻译 EtherType、剥头后把载荷交付给唯一确定的上层入口。错误一律走「统计 + 释放」。

**发包 → 封装 → 发送**：`ethernet_output` 是唯一的帧级出口。它做三件事：预留头部空间、填入 dest/src/type、交给 `netif->linkoutput`。错误一律走「不发送，返回错误」。

两条流水线之间没有共享的可变状态，因此可以互为并发而不需要锁——这就是链路层无状态机在实现层面的体现。上层（ARP、IP）的确定性状态转移请到对应模块阅读。