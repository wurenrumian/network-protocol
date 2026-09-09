# UDP · state-machine

## 状态

UDP **没有显式状态机**：无连接建立/拆除、无序列号、无定时器。协议状态被压缩为 PCB（`struct udp_pcb`）的**绑定关系**，由 `flags` 中的 `UDP_FLAGS_CONNECTED` 位区分两种状态：

- **UNBOUND**：`local_port == 0`，尚未绑定本地端口；只能作为发送方（`udp_sendto`），不能接收。
- **BOUND**：已绑定 `local_ip`/`local_port`，可接收目的端口匹配的报文。
- **CONNECTED**：在 BOUND 基础上设置 `remote_ip`/`remote_port`，置 `UDP_FLAGS_CONNECTED`；只接收来自该对端的报文，可用无地址参数的 `udp_send`。CONNECTED 不隐含任何传输层连接语义——只是 PCB 的过滤与寻址快捷方式。

状态由 PCB 字段刻画，没有独立的状态机数据结构。

## 事件

| 事件 | 触发者 | 作用对象 | 效果 |
| --- | --- | --- | --- |
| `udp_new` | 应用 | PCB | 分配 PCB，进入 UNBOUND |
| `udp_bind` | 应用 | PCB | 设 local_ip/local_port，进入 BOUND |
| `udp_connect` | 应用 | PCB | 设 remote，置 CONNECTED 位 |
| `udp_disconnect` | 应用 | PCB | 清 remote 与 CONNECTED 位，退回 BOUND |
| `udp_remove` | 应用 | PCB | 从链表摘除并释放 |
| 收到报文 | IP 层（`udp_input`） | 端口表 | 查找匹配 PCB 并回调；不改变 PCB 状态 |
| `udp_sendto`/`udp_send` | 应用 | PCB | 构造并发送；不改变 PCB 状态 |

## 状态转移

```text
UNBOUND --udp_bind--> BOUND --udp_connect--> CONNECTED
                  ^                          |
                  +---- udp_disconnect -------+
任意状态 --udp_remove--> （释放，退出）
```

- 发送不改变状态；接收不改变状态。
- `udp_bind` 可用端口 0 让内核选端口；`udp_connect` 前需已绑定或由发送路径自动确定本地端口。

## 正常 / 异常时序

### 正常：无连接发送（sendto）

```text
应用 --udp_sendto(dst)--> udp_sendto 构造头+校验和 --> ip4/ip6_output_if --> 网络
```

不经过任何状态转移；每个报文独立寻址。

### 正常：connected 会话

```text
应用 --udp_bind--> --udp_connect--> --udp_send(无地址)--> 对端
对端回包 --> ip_input --> udp_input --> 遍历 udp_pcbs 匹配 --> 校验 --> recv 回调
```

### 异常：无匹配 PCB

```text
udp_input --> 遍历 udp_pcbs 未命中 --> 丢弃（可回 ICMP 端口不可达）
```

### 异常：校验失败 / 长度异常

```text
udp_input --> 长度/校验失败 --> 静默丢弃，统计计数
```

## 处理流程（无显式状态机时）

UDP 的「状态机」退化为两条确定的处理流程，均以 PCB 绑定关系为输入：

### 收包流程

```text
ip4_input / ip6_input（协议号 17）
  → udp_input（src/core/udp.c）
      → 解析 udp_hdr，检查最小长度（p->len >= UDP_HLEN）
      → 遍历 udp_pcbs：connected PCB 优先 → bound PCB → wildcard PCB
      → 命中（或目的地为本机）在校验分支做校验和验证
      → 命中：recv 回调上抛载荷 pbuf
      → 未命中：丢弃
```

### 发包流程

```text
udp_sendto（携带目的地址）/ udp_send（用 PCB remote）
  → 校验目的地址与端口合法性
  → 计算伪头校验和（NOCHKSUM flag 可跳过，仅 IPv4）
  → 构造 udp_hdr + 载荷 pbuf
  → ip4_output_if / ip6_output_if 交给 IP 层
```

两条流程之间没有共享状态，只有 PCB 的绑定/连接信息作为连接点——这正是 UDP 无连接模型的体现。