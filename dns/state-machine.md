# DNS · state-machine

Unbound 的迭代器把"一次递归解析"实现为**显式状态机**：`enum iter_state`（定义于 `iterator/iterator.h`，实现于 `iterator/iterator.c`）。每条消息事件在 `iter_operate()` 入口，由 `iter_handle()` 内的 `while(cont)` 循环驱动状态推进：`process*State()` 返回真则继续，假则挂起等待子查询/应答。

## 状态

| 状态 | 职责 | 进入条件 |
|---|---|---|
| `INIT_REQUEST_STATE` | 解析起点：查缓存、找/启动委派 | 新查询；CNAME 重启；last resort 向上取父 NS |
| `INIT_REQUEST_2_STATE` | 处理 stub 预置、DS/glue 的父域调整 | 已确定委派点（含 root prime 返回后） |
| `INIT_REQUEST_3_STATE` | 设 `dnssec_expected`、RD 语义收尾 | stub prime 之后；确定要发往权威 |
| `QUERYTARGETS_STATE` | **目标选择与发送**：选 NS 地址、发查询、处理超时重试 | 每次换委派点/换目标必经 |
| `QUERY_RESP_STATE` | 应答分类：ANSWER/REFERRAL/CNAME/LAME/THROWAWAY | 收到上游应答 |
| `PRIME_RESP_STATE` | 预置查询（root/stub prime）应答处理 | priming 子查询结束 |
| `COLLECT_CLASS_STATE` | qclass=ANY 时逐类合并 | 新查询 qclass=ANY |
| `DSNS_FIND_STATE` | DS 查询：定位到正确的父 NS 再查 DS | qtype=DS 且应答层级过浅 |
| `FINISHED_STATE` | 组装返回消息、写缓存、交回上游 | 最终应答就绪 |

状态共 9 个（`INIT_REQUEST_STATE`=0 起）。每个 `iter_qstate` 还有 `final_state`（本地查询的终态，如 `PRIME_RESP_STATE`），`next_state()` 校验：进入 response 状态必须有 `iq->response`。

## 事件

模块层事件（`enum module_ev`，见 `util/module.h`，未复制）：

- `module_event_new`：新客户端查询（`mesh_new_client` 创建 qstate 后调用 `iter_operate`）。
- `module_event_pass`：上游模块（如 validator）处理完毕后交回，继续迭代。
- `module_event_reply`：上游应答（经 `worker_handle_service_reply → mesh_report_reply`）。
- `module_event_noreply`：上游超时（`NETEVENT_TIMEOUT`）。
- `module_event_error`：网络错误/畸形包。
- `module_event_capsfail`：0x20 大小写校验失败（潜在缓存投毒），触发 fallback。

子查询通过 `iter_inform_super()` 回调父查询：priming 结果、target 结果、DS 结果、错误分别进入 `prime_supers / processTargetResponse / processDSNSResponse / error_supers`。

## 状态转移

```
                    ┌──────────────────────────────────────────────┐
                    │            (CNAME 重启 / last resort 向上)    │
                    ▼                                              │
 新查询 ──> INIT_REQUEST_STATE ──> INIT_REQUEST_2_STATE ──> INIT_REQUEST_3_STATE
               │  cache命中ANSWER               │                    │
               │  └─────────> FINISHED_STATE ◄───┘                    │
               │  cache命中CNAME ──重启(restart_count++)              │
               │  cache未命中：dns_cache_find_delegation               │
               │    无委派 ──> prime_root/prime_stub (子查询)          │
               │        └─> 等待 prime_supers ─> INIT_REQUEST_2_STATE  │
               └─────────────────────────────────┘                    ▼
                                                              QUERYTARGETS_STATE
                                                                  │ 选目标、发送
                                                                  │ (超时→再选, timeout_count++)
                                                                  ▼
                                                            QUERY_RESP_STATE
                                                          ┌─────────┤
                                              ANSWER ──────┤         │ REFERRAL
                                              (存缓存)      │         │ (dp=新委派,
                                                          │         │  referral_count++,
                                                          │         │  dnssec_expected 重估)
                                                          │         ▼
                                                          │   QUERYTARGETS_STATE
                                                          │
                                              CNAME ──────┘  ──> INIT_REQUEST_STATE
                                                          (restart_count++)
                                              LAME/THROWAWAY/超时 ──> QUERYTARGETS_STATE
                                              (换目标)
```

关键转移的计数器语义：

- 进入 `QUERY_RESP_STATE` 前：`num_current_queries++`；处理应答时 `--`（`processQueryResponse` 第一行）。
- REFERRAL：`referral_count++`、`sent_count=0`、`dp_target_count=0`，清空 outlist 与子查询，`iq->dp = delegpt_from_message()`。
- CNAME：`query_restart_count++`（QNAME minimization 的中间查询除外）、清状态回 `INIT_REQUEST_STATE`。
- root/stub prime：子查询走 `PRIME_RESP_STATE`，完成后 `prime_supers()` 把结果转成委派点，按 `wait_priming_stub` 决定回 `INIT_REQUEST_2_STATE` 还是 `INIT_REQUEST_3_STATE`。

## 正常时序

### 典型迭代（www.example.com A，全缓存未命中）

```
client → worker_handle_request (RD=1)
  → mesh_new_client → iter_operate(module_event_new) → iter_new(state=INIT_REQUEST_STATE)
  → processInitRequest: dns_cache_lookup miss → dns_cache_find_delegation miss → prime_root
      （子查询 . NS → root hints 的 A/AAAA 地址）
  → prime_supers → INIT_REQUEST_2_STATE → INIT_REQUEST_3_STATE(dnssec_expected 评估)
  → QUERYTARGETS_STATE: iter_server_selection → send_query(root 服务器, "com NS")
  → QUERY_RESP_STATE: REFERRAL → delegpt_from_message(dp=com) → QUERYTARGETS_STATE
  → send_query(com 服务器, "example.com NS")
  → QUERY_RESP_STATE: REFERRAL → dp=example.com → QUERYTARGETS_STATE
  → send_query(example.com 权威, "www.example.com A")
  → QUERY_RESP_STATE: ANSWER → iter_dns_store 写缓存 → FINISHED_STATE
  → processFinished: 置 RA/QR、清 AA、返回 qstate->return_msg → worker 回包客户端
```

### CNAME 追查

```
QUERY_RESP_STATE 收到 CNAME → handle_cname_response 记录追查名
  → 以 referral 方式存缓存（只存 RRset，不存部分消息）
  → iq->qchase 换成目标名 → query_restart_count++ → INIT_REQUEST_STATE
  → 重复缓存查找/迭代，直到最终 ANSWER 或 MAX_RESTART_COUNT 封顶
```

## 异常时序

### 目标全部超时

```
QUERYTARGETS_STATE 选目标 → send_query → (无应答) module_event_noreply
  → process_response: timeout_count++, state=QUERY_RESP_STATE
  → processQueryResponse(iq->response==NULL): 回 QUERYTARGETS_STATE 换目标
  → 全部目标耗尽:
      num_target_queries==0 && num_current_queries==0
      → 有缺失目标则 query_for_targets（等子查询）
      → 无 → processLastResort:
          · 有父侧 NS/glue → 回 QUERYTARGETS_STATE
          · 无且是 root → 用 root hints 填 last resort
          · 无 → SERVFAIL
  → 连续超时 ≥3 且启用 use_caps_bits_for_id → caps_fallback（0x20 重新查询，最多 3 倍服务器数）
```

### LAME / 投毒防护

```
应答判定 RESPONSE_TYPE_LAME/REC_LAME（对非 qname 子域 NS 的应答、DNSSEC 缺失等）
  → infra_set_lame 标记该地址
  → 回 QUERYTARGETS_STATE，iter_server_selection 降权该地址
scrub_message 失败（无关记录/坏包）→ scrub_failures++ → 丢弃，换目标
capsfail（0x20 ID 不匹配）→ 触发 0x20 fallback，用随机大小写重新发同查询
```

### 根预置失败

```
prime_root 子查询最终无结果（prime 响应非正 ANSWER）
  → prime_supers: delegpt_from_message 失败 → foriq->dp=NULL, state=QUERYTARGETS_STATE
  → QUERYTARGETS_STATE 见 dp==NULL → "failed to get a delegation" → SERVFAIL
```

## 处理流程（无显式状态机时）

消息缓存与 RRset 缓存不持有状态机，只维护"键 → 条目 + TTL"的查找/写入函数：

- `dns_cache_lookup`：查消息缓存（命中且未过期直接整答）；未命中按 DNAME/CNAME 最近匹配做合成（`find_closest_of_type`）。
- `dns_cache_store(_msg)`：写 RRset（`rrset_cache_update`，带 leeway 与 NS 特殊规则），TTL 0 时只存 RRset 不存消息，并 `msg_del_servfail` 清掉 SERVFAIL。
- `rrset_cache_lookup/update`：slabhash + LRU；更新时 `need_to_update_rrset()` 比较新旧 TTL，缓存中已有更新鲜数据则保留旧值（`equal` 时保持缓存）。

这些函数配合迭代状态机工作：缓存命中把迭代器直接推向 `FINISHED_STATE` 或触发 CNAME 重启；缓存未命中才进入网络迭代。