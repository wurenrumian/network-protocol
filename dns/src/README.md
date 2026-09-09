# DNS · src

本文件是源码导航页，不复述协议内容，只维护文件清单、阅读顺序与裁剪说明。协议本身见 `protocol.md` 与 `state-machine.md`。

## 上游版本

- 仓库：`github.com/NLnetLabs/unbound`
- tag：`release-1.17.0`
- commit：`d25e0cd9b0545ff13120430c94326ceaf14b074f`
- 许可证：BSD-3-Clause，`LICENSE`（已复制到 `LICENSES/`）
- 复制方式：从 `raw.githubusercontent.com/NLnetLabs/unbound/release-1.17.0/<path>` 逐文件下载，保留原相对目录结构。

## 文件清单（文件 → 类别 → 阅读范围）

按 `protocol-learning-design.md` §3 的三类标记：

| 文件（`src/upstream/` 下路径） | 类别 | 阅读范围 |
|---|---|---|
| `daemon/worker.c` | integration | 客户端请求入口 `worker_handle_request()`（EDNS 解析、ACL、消息缓存命中/未命中分发）；`worker_check_request()`（报文合法性）；`worker_handle_service_reply()`（上游应答回调）；`worker_send_query()`（发给上游）。**跳过**：dnscrypt/dnstap/remote 控制台/shm 等平台化部分 |
| `iterator/iterator.c` | core | 迭代状态机全部：`iter_operate()`、`iter_handle()`、`iter_new()`、`processInitRequest[1-3]`、`processQueryTargets()`、`processQueryResponse()`、`processPrimeResponse()`、`processFinished()`、`processLastResort()`、`prime_supers()`、`processTargetResponse()`、`iter_inform_super()`、`next_state()`、`final_state()` |
| `iterator/iter_hints.c` | core | root hints / stub hints：`hints_apply_cfg()`、`read_root_hints()`、`hints_lookup_root()`、`hints_lookup_stub()` |
| `services/cache/dns.c` | core | 消息缓存与委派查找：`dns_cache_lookup()`、`dns_cache_store()`、`dns_cache_store_msg()`、`dns_cache_find_delegation()`、`find_closest_of_type()`（DNAME/CNAME 合成）、`tomsg()` |
| `services/cache/rrset.c` | core | RRset 缓存：`rrset_cache_lookup()`、`rrset_cache_update()`、`rrset_cache_touch()`、`need_to_update_rrset()` |
| `util/data/msgparse.c` | core | wire 解析：`parse_packet()`、`parse_query_section()`、`parse_section()`、`parse_rrset()`、`parse_edns_from_query_pkt()`、`parse_extract_edns_from_response_msg()`、`skip_pkt_rr()`、`pkt_dname_len()`（name 压缩与深度限制） |
| `util/data/packed_rrset.c` | core | RRset 内存表示：`packed_rrset_copy_region()`、`packed_rrset_ttl_add()`、`get_cname_target()`、`packed_rrset_find_rr()`、`ub_rrset_compare()` |

## 阅读顺序与调用链

推荐按一条"客户端查询 → 应答"闭环组织：

```
worker_handle_request()            [daemon/worker.c]   请求入口：EDNS/ACL/合法性
  ├─ message cache 命中 → answer_from_cache() → 直接回包
  └─ 未命中 → mesh_new_client() → 模块管道
       └─ iter_operate(module_event_new)          [iterator/iterator.c]
            └─ iter_handle() while 循环驱动状态机
                 ├─ processInitRequest1-3
                 │    ├─ dns_cache_lookup()        [services/cache/dns.c]   消息缓存
                 │    ├─ dns_cache_find_delegation() [services/cache/dns.c] 委派查找
                 │    └─ prime_root() → hints_lookup_root() [iterator/iter_hints.c]
                 ├─ processQueryTargets()
                 │    └─ (*send_query)() → worker_send_query() [daemon/worker.c] 发上游
                 ├─ processQueryResponse()：应答分类
                 │    ├─ parse_packet()            [util/data/msgparse.c]   wire 解析
                 │    ├─ scrub_message()（iter_scrub.c，未复制）
                 │    └─ iter_dns_store() → dns_cache_store() [services/cache/dns.c]
                 │         └─ rrset_cache_update() [services/cache/rrset.c]
                 └─ processFinished() → return_msg → 回包客户端
```

先读 `msgparse.c` → `packed_rrset.c`（报文怎么变成对象），再读 `dns.c`/`rrset.c`（对象怎么缓存），最后读 `iterator.c` + `iter_hints.c` + `worker.c` 把它们串成闭环。

## 入口函数 / 结束函数

| 文件 | 入口 | 结束 |
|---|---|---|
| `daemon/worker.c` | `worker_handle_request()`（客户端请求） | 回包客户端（`send_reply` 标签 / `comm_point_send_reply`）；上游应答经 `worker_handle_service_reply() → mesh_report_reply()` |
| `iterator/iterator.c` | `iter_operate()`（模块事件入口） | `processFinished()` 置 `qstate->return_msg` / `error_response()` 置 SERVFAIL |
| `iterator/iter_hints.c` | `hints_apply_cfg()`（启动装配） | `hints_lookup_root()/hints_lookup_stub()`（查询） |
| `services/cache/dns.c` | `dns_cache_lookup()` / `dns_cache_store()` | 返回 `struct dns_msg*`（含 `reply_info`）供迭代器消费 |
| `services/cache/rrset.c` | `rrset_cache_lookup()` / `rrset_cache_update()` | 返回 `struct ub_packed_rrset_key*` / 更新状态码 |
| `util/data/msgparse.c` | `parse_packet()` | 填充 `struct msg_parse`（RRset 链 + 哈希表） |
| `util/data/packed_rrset.c` | `packed_rrset_copy_region()` 等构造 | `packed_rrset_find_rr()` / `packed_rrset_ttl_add()` 维护 |

## 未复制的依赖

迭代闭环引用了以下模块/头文件，**未复制**，需在上游仓库对应路径查看（均为 `release-1.17.0`）：

- **validator 模块**：`validator/val_*.c`（信任锚、DS、NSEC/NSEC3 负证明、`sec_status`）——`iterator.c` 的 `dnssec_expected`、`iter_indicates_dnssec()` 只判定"需要验证"，真正验证在 validator。
- **services/mesh.c / services/mesh.h**：请求去重与模块管道（`mesh_new_client`、`mesh_report_reply`）——`worker.c` 与 `iterator.c` 大量调用。
- **services/outside_network.c**：上游 socket/超时/ID 管理（`outnet_serviced_query`）——`worker_send_query` 依赖。
- **services/cache/infra.c**：infra cache（RTT、EDNS 能力、lame 标记）。
- **services/cache/neg_cache（validator/val_neg.c）**：负缓存与负证明。
- **util/storage/slabhash.c / lruhash.c**：哈希表/LRU 缓存基元（`slabhash_lookup/insert`）。
- **util/data/msgreply.c、dname.c、msgencode.c**：`reply_info`/`query_info` 构造、名字比较、应答编码。
- **iterator/iter_scrub.c、iter_utils.c、iter_delegpt.c、iter_resptype.c、iter_fwd.c、iter_donotq.c、iter_priv.c**：scrub、目标选择工具、delegpt、应答分类、forward 区、黑名单。
- **sldns/（sbuffer.c、rrdef.c、wire2str.c、str2wire.c、parseutil.c）**：buffer/类型表/wire 工具库。
- **util/config_file.c、util/module.c、util/netevent.c、util/regional.c、util/alloc.c、util/log.c、util/random.c、util/fptr_wlist.c、util/tube.c**：配置/模块框架/事件循环/内存区/日志/随机。
- **daemon/daemon.c、daemon/remote.c、daemon/acl_list.c**：守护进程装配、控制通道、ACL（`worker.c` 的 ACL 检查依赖）。
- **services/listen_dnsport.c、services/authzone.c、services/localzone.c、services/rpz.c、respip/、libunbound/**：监听端口、权威区、本地区、RPZ、响应 IP、库接口。
- **配置生成文件**：`config.h` 由 autoconf 生成，不复制。

## 已复制 / 跳过说明

- 已复制 7 个 `.c` 文件 + `LICENSE`，见「文件清单」。
- **跳过**：所有 `.h` 头文件（`iterator.h` 中 `enum iter_state` 等定义已在 `state-machine.md` 中摘录）、构建文件、`doc/`、`validator/`、`services/outside_network.c`、`services/mesh.c`、`util/storage/` 等。
- 未出现 404 跳过项：全部目标 URL 均下载成功（`iterator/iter.c` 在上游不存在，实际文件名为 `iterator/iterator.c`，已按此复制）。
- 复制的是纯净上游文件；学习注释统一以 `[RFC: ...]` / `[STATE]` / `[INVARIANT]` / `[BOUNDARY]` 格式追加在 `src/upstream/` 副本上，不改控制流。当前副本未加任何学习注释，尚未引入补丁文件。