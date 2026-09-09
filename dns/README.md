# DNS

## 定位

DNS 把"人类可读的域名"解析为"机器可用的地址（IP 或其他资源记录）"，并回答一个核心问题：**在分布式、无共享权威状态的命名空间中，如何可靠、高效地把一个名字解析到它所属的记录，同时抵抗缓存污染和伪造？**

本模块关注四件事：

1. **wire format**：消息如何在 UDP/TCP 上编码（12 字节头、四段式 section、name 压缩、EDNS）；
2. **递归解析**：客户端只需发一个 RD 查询，resolver 负责从 root → TLD → authoritative 逐级迭代直至答案；
3. **缓存与委派**：结果和委派点如何被缓存并复用，TTL 如何控制一致性；
4. **DNSSEC 验证**：如何用 DNSKEY/DS/RRSIG 链式验证应答的完整性。

主实现为 **Unbound**（NLnet Labs，BSD 许可的递归 resolver）。相比 BIND 的庞大功能面，Unbound 的模块化设计（`daemon/` 负责 I/O、`iterator/` 负责迭代、`services/cache/` 负责缓存、`validator/` 负责验证）与"递归+缓存"这一主题高度对应，源码规模更适合逐文件追踪一条闭环。

本模块只读上述闭环相关的完整文件，不复制通用库、构建脚本和平台适配。

## 前置模块

- **UDP**：DNS 默认走 UDP 53，512 字节经典上限与 65535 字节 TCP 上限的取舍是本模块边界条件之一（EDNS 扩展了 UDP 上限）。
- **TCP**：截断（TC bit）后重试、长响应与 zone transfer 走 TCP。
- **IP / 地址族**：NS 记录需要其 A/AAAA（glue）地址才能发起迭代查询；Unbound 分别统计 ipv4/ipv6 支持。
- **协议抽象与编码**：字节序、长度边界、TLV 分析语言（EDNS OPT 即一种 TLV 扩展）。

阅读顺序上建议在 UDP → TCP 之后进入 DNS（对应 `protocol-learning-design.md` §4.4 → §4.5）。

## 推荐阅读顺序

1. 先读 `protocol.md`，建立问题定义、抽象对象与 wire format 的完整图景；
2. 再读 `state-machine.md`，理解"一次递归解析"如何分解为状态流转（root 启动 → 委派 → 目标选择 → 应答分类 → CNAME/委派处理）；
3. 进入 `src/README.md`，沿调用链读源码：
   - `util/data/msgparse.c`（wire 解析：`parse_packet`）
   - `util/data/packed_rrset.c`（RRset 的内存表示）
   - `services/cache/dns.c`、`services/cache/rrset.c`（两级缓存）
   - `iterator/iterator.c`（迭代状态机，核心）
   - `iterator/iter_hints.c`（root hints）
   - `daemon/worker.c`（事件入口与调度，串起整条链路）
4. 阅读时对照 `references.md` 中的 RFC 章节号。

## 源码入口

- 客户端请求入口：`daemon/worker.c:1260 worker_handle_request()`
- 迭代状态机入口：`iterator/iterator.c:4140 iter_operate()`
- wire 解析入口：`util/data/msgparse.c:908 parse_packet()`
- 消息缓存：`services/cache/dns.c:890 dns_cache_lookup()` / `:1058 dns_cache_store()`
- RRset 缓存：`services/cache/rrset.c:276 rrset_cache_lookup()` / `:186 rrset_cache_update()`
- root hints：`iterator/iter_hints.c:439 hints_apply_cfg()`、`:468 hints_lookup_root()`

详见 `src/README.md`（文件清单、阅读范围、未复制依赖）。

## 主实现 / 对照实现

- 主实现：**Unbound**（`github.com/NLnetLabs/unbound`，tag `release-1.17.0`，见 `references.md`）。
- 对照：**BIND9**（完整权威+递归，验证生态标杆）、**c-ares**（客户端异步解析库，无递归状态机，适合对照"resolver 与 stub 的分工"）。

## 目录规范

参见根目录 `protocol-learning-design.md` §3：5 份模块文档 + `src/`（`LICENSES/` 保存许可证、`upstream/` 保存上游文件、`src/README.md` 作源码导航页）。