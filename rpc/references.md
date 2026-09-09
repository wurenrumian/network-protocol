# RPC 与序列化 · references

## 规范 / 标准

- **gRPC Core Specification**：协议概述、帧格式、message type、`grpc-status`、metadata 键、HTTP/2 映射。
  https://github.com/grpc/grpc/blob/master/doc/core/grpc-client-server.md
- **gRPC Over HTTP/2**（协议主文档）：帧封装、HTTP/2 使用细节。
  https://github.com/grpc/grpc/blob/master/doc/core/grpc-http2.md
- **gRPC proto 文件与 method 命名**：`.proto` 到 `host/method` 的映射。
  https://github.com/grpc/grpc/blob/master/doc/core/grpc-client-server.md#service-and-method
- **Protocol Buffers Encoding**（官方编码文档）：varint、tag、length-delimited、嵌套消息。
  https://protobuf.dev/programming-guides/encoding/
- **Protocol Buffers Language Guide（proto 语言）**：`.proto` 语法、字段号、repeated、map、oneof。
  https://protobuf.dev/programming-guides/proto3/
- **HTTP/2 RFC 9113**：stream、frame、flow control、RST_STREAM、half-close（gRPC 传输的前提）。
  https://www.rfc-editor.org/rfc/rfc9113
- **ONC RPC / JSON-RPC（对照谱系起点）**：
  - RFC 5531（RPC）、RFC 4506（XDR）：https://www.rfc-editor.org/rfc/rfc5531
  - JSON-RPC 2.0 规范：https://www.jsonrpc.org/specification

## 论文

- **Google Protocol Buffers**（编码设计的原始说明，2008）：
  https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/33931.pdf
- **Thrift: Scalable Cross-Language Services Implementation**（Facebook 论文，2011）：
  https://erlang.org/euc/07/papers/1700Einarsson.pdf
- **gRPC 官方博客与 whitepaper 风格资料**（gRPC 设计动机、与 REST 对比）：
  https://grpc.io/docs/what-is-grpc/introduction/

## 上游仓库（固定版本 / commit）

### gRPC（主实现：RPC 语义）

- 仓库：https://github.com/grpc/grpc
- 固定 tag：**v1.60.2**
- commit：`0bab87ede8244a21fce01294a364cc9a7fc99ed8`（tag `refs/tags/v1.60.2` 解析值）
- 许可证：Apache License 2.0（本模块 `src/LICENSES/LICENSE`）
- 本模块复制的文件（均来自该 tag）：
  - `src/core/lib/surface/call.cc`
  - `src/core/lib/surface/channel.cc`
  - `src/core/lib/surface/server.cc`
  - `src/core/lib/transport/transport.cc`
  - `src/core/lib/slice/slice.cc`
  - `src/core/lib/gprpp/ref_counted_ptr.h`
  - `LICENSE`

### Protocol Buffers（主实现：序列化）

- 仓库：https://github.com/protocolbuffers/protobuf
- 固定 tag：**v26.1**
- commit：`8536c48e19ca4e74c4fc6fc1235850eeabc8afac`（tag `refs/tags/v26.1` 解析值）
- 许可证：BSD-3-Clause（许可证文本见仓库 `LICENSE`，本模块未复制，见 `src/README.md`）
- 本模块复制的文件：
  - `src/google/protobuf/wire_format.cc`

## 其他实现

- **Apache Thrift**（对照：序列化 + 传输分层）：https://github.com/apache/thrift
  - 对比点：IDL 与传输解耦、请求 ID / 多路复用需自行设计、二进制/compact 协议。
- **Cap'n Proto**（对照：零拷贝 / 免解析）：https://github.com/capnproto/capnproto
  - 对比点：编码即内存布局、无解析读取、wire 尺寸与可演进性取舍。
- **FlatBuffers**（对照，同属零拷贝谱系）：https://github.com/google/flatbuffers
- **Tars / Dubbo**（补充对照，国内实践中的 RPC 协议设计）：
  - Tars：https://github.com/Tencent/Tars
  - Dubbo：https://github.com/apache/dubbo

## 阅读备注

- **固定版本**：gRPC 建议 tag 为 v1.60.x，已核实并固定为 v1.60.2（v1.60 系列最新 patch，2024 年发布）；protobuf 固定为 v26.1。若后续需要对照更新的实现，须另行固定 tag 并记录 commit。
- **channel.cc 的路径差异**：设计文档建议的 `src/core/lib/channel/channel.cc` 在 v1.60.2 中**不存在**——该目录被拆分为 `channel_stack.cc`、`channel_stack_builder*.cc`、`connected_channel.cc` 等文件；channel 的 surface 实现在 `src/core/lib/surface/channel.cc`。本模块复制 `src/core/lib/surface/channel.cc` 作为 channel 主入口，并在 `src/README.md` 注明。
- **已知未复制**：protobuf 仓库的 `LICENSE`（BSD-3-Clause）未复制；gRPC core 的 HTTP/2 帧引擎（`src/core/lib/http2/`）、name resolver、TLS、completion queue 内部实现、未生成的 metadata 定义（`transport/metadata_batch.h`）等未复制。原因与依赖关系见 `src/README.md`。
- **学习注释**：`src/upstream/` 下的复制文件可在不改动控制流的前提下加学习注释（格式见根设计文档 §3）。所有修改仅限注释，不伪装成上游改动。
- **相关规范名词**：gRPC metadata 的 `grpc-timeout`、`grpc-status`、`grpc-accept-encoding` 等在官方 doc 中有权威定义，阅读时以 `doc/core/grpc-http2.md` 为准。