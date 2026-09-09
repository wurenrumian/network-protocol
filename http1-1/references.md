# HTTP/1.1 · references

## 规范 / 标准

| 文档 | 内容 | 本模块用途 |
| --- | --- | --- |
| RFC 7230 | HTTP/1.1 消息语法与路由（message framing、keepalive、chunked、`Connection`） | wire format 的主依据 |
| RFC 7231 | 语义与内容（方法、状态码、表示） | 方法与状态码语义 |
| RFC 7232 | 条件请求（If-Match / If-None-Match 等） | header 语义（旁支） |
| RFC 7233 | 范围请求（Range / Content-Range） | 部分响应语义（旁支） |
| RFC 7234 | 缓存 | 缓存语义（旁支） |
| RFC 7235 | 认证（WWW-Authenticate / Authorization） | 认证语义（旁支） |
| RFC 9110 | HTTP Semantics（取代 RFC 7230–7235 的语义部分） | 当前规范的首选引用 |
| RFC 9111 | HTTP Caching（取代 RFC 7234） | 缓存（旁支） |
| RFC 9112 | HTTP/1.1（取代 RFC 7230 的消息语法部分） | 定界、keepalive、chunked 的现行权威 |
| RFC 1945 | HTTP/1.0 | 兼容性依据 |

阅读建议：以 RFC 9112 §2（Message Format）、§6（message framing / body）、§7.1（chunked）、§9（Connection 管理）为主线，RFC 9110 §9（方法）、§15（状态码）为语义参考。obs-fold、pipelining 等历史内容对照 RFC 7230/9112 的区别理解 nginx 的实现取舍。

## 论文

- Fielding 等，Hypertext Transfer Protocol 系列 RFC 的规范过程，可读 RFC 9112 附录（Acknowledgments / changes）理解各版差异的来由。
- 请求走私研究（HTTP request smuggling）相关安全分析文章，用于理解「解析歧义 → 关闭连接」不变量为何存在。

## 上游仓库（固定版本 / commit）

| 项 | 值 |
| --- | --- |
| 主实现 | nginx |
| 仓库 | https://github.com/nginx/nginx |
| 固定 tag | `release-1.25.3` |
| 固定 commit | `b8fb83b8d2e7ca03d43176b767f1fc657f1c1ee2` |
| 获取方式 | `git clone --branch release-1.25.3 https://github.com/nginx/nginx.git` |

校验：

```
$ git ls-remote https://github.com/nginx/nginx.git refs/tags/release-1.25.3
b8fb83b8d2e7ca03d43176b767f1fc657f1c1ee2        refs/tags/release-1.25.3
```

许可证：BSD 2-Clause，`docs/text/LICENSE`（见 `src/LICENSES/LICENSE`）。nginx 官方文档：https://nginx.org/docs/ 。

## 其他实现

| 实现 | 定位 | 比较角度 |
| --- | --- | --- |
| curl | 客户端 HTTP/1.1 实现 | 客户端视角的解析与响应处理；与 nginx 的服务端解析对比 |
| llhttp | 独立、无依赖的 HTTP parser（Node.js 使用） | 状态机写法、增量解析、错误处理与 nginx parser 的对照 |
| Apache httpd / h2o | 其他服务端 | 请求解析与 keepalive 策略的取舍对照（可选） |

## 阅读备注

- nginx 的解析器不复制字节、只扫描缓冲区；注意 `NGX_AGAIN` 返回时游标已推进，这是增量解析正确性的关键。
- `ngx_http_parse.c` 被 `ngx_http_request.c` 等直接调用，解析函数声明在 `src/http/ngx_http.h`（无 `ngx_http_parse.h` 文件）。
- chunked 编码在请求方向由 parser 消费；响应方向由 `ngx_http_copy_filter_module.c` 生成，且 nginx 默认尽量不用 chunked（见 `protocol.md` 设计取舍）。
- 本模块复制了 8 个上游文件（5 个 `src/http/*.c` + `ngx_http.h` + `ngx_http_request.h`）与 LICENSE；未复制事件循环、socket、buffer 等依赖，清单见 `src/README.md`。其中 `ngx_http_read_client_request_body`/`ngx_http_discard_request_body` 定义于未复制的 `ngx_http_request_body.c`，需回上游补充阅读。
- 学习注释可写在 `src/upstream/` 副本上，统一格式见根目录 `protocol-learning-design.md` §3 示例。