# RDMA · references

## 规范 / 标准

| 文档 | 内容 | 本模块的用途 |
| --- | --- | --- |
| **InfiniBand Architecture Specification**（ibta，v1.9 / v1.8） | 链路层、网络层（GRH）、BTH、QP 状态机、可靠性语义（RC/UC/UD）、报文格式 | QP 状态机合法性（§9.2.1）、报文字段语义、CQ/WC 约定 |
| **RoCE**：InfiniBand Architecture 的 RDMA over Converged Ethernet 补充 v1 与 RoCEv2（把 IB 报文迁到 IPv4/IPv6 + UDP 4791） | RoCEv1：IB GRH 直接在 Ethernet II；RoCEv2：IPv4/IPv6 + UDP 4791 封装 IB 报文 | AH → MAC/IP 的解析、GID 的 IP 语义 |
| **rdma_cm API**（`librdmacm` 的公开语义，见 man rdma_cm） | create_id/bind/resolve/listen/connect/accept 的连接生命周期 | 与 `cma.c` 的对应 |
| **ibverbs**（`ibv_*` API 手册） | MR/PD/QP/WR/WC/CQ/AH 的对象语义 | 各 API 行为 |

> 下载：IBTA 规范需会员下载；RoCEv2 可参考 `rdma-core` 的 `docs`/Mellanox 白皮书。不强制要求本地留存。

## 论文

本模块以规范与源码为主，论文仅作背景，不构成必读。

| 材料 | 内容 | 与本模块的关系 |
| --- | --- | --- |
| Mellanox "RDMA over Converged Ethernet（RoCE）Architectures" 白皮书 | RoCE 的网络设计 | AH 与 GID 的关系 |
| "An Introduction to InfiniBand"（Scott S., 2010s） | IB 各层与报文 | 报文字段定位 |

> 若不追求文献，本模块主要依赖 IB/RoCE 规范 + rdma-core 源码本身即可闭环。

## 上游仓库（固定版本 / commit）

| 仓库 | 固定版本 | 说明 |
| --- | --- | --- |
| **linux-rdma/rdma-core** | tag `v49.0`，commit `7e813ec60153061260ddfb216f4633b55ca4e99a` | 本模块主实现；`libibverbs/`、`librdmacm/`、`providers/rxe/` 的源代码 |
| linux-rdma/rdma-core 的 Linux 内核侧（仓库内 `kernel/` 目录） | 与 v49.0 配套的内核代码 | uverbs/rdma_cm 的接收端；**未复制**，见 `src/README.md` |

获取方式（已执行）：

```bash
TAG=v49.0
BASE=https://raw.githubusercontent.com/linux-rdma/rdma-core/$TAG
# 复制 libibverbs/*.c、librdmacm/*.c、providers/rxe/rxe.c 到 src/upstream/
# 复制 COPYING.md / COPYING.BSD_MIT / COPYING.GPL2 到 src/LICENSES/
```

## 其他实现

| 实现 | 角色 | 备注 |
| --- | --- | --- |
| **Linux 内核 uverbs / rdma_cm** | 对照：ioctl 接收端与 QP 状态机的权威实现 | 需单独取内核源码（不在本仓库） |
| **Soft-RoCE（RXE）内核模块** | 对照：数据路径与 IB/RoCE 报文的实际构造/解析 | 用户态 `rxe.c` 只是它的一面镜子 |
| **Mellanox/ConnectX 固件** | 硬件实现 | 只读支撑，不参与阅读 |
| InfiniBand 的 SM（opensm/ibutils） | 子网管理器 | 对照 GID/LID 分配 |

## 阅读备注

- **许可证**：rdma-core 默认双许可（OpenIB.org BSD-MIT 或 GPLv2），见 `src/LICENSES/COPYING.md` 与 `COPYING.BSD_MIT`/`COPYING.GPL2`。复制仅限学习，若对外发布须遵循许可条款；对 `librdmacm` 等标"See COPYING"的文件，两种许可均可选。
- **修改策略**：本模块未对上游做任何改动；如需修正或加注，只加 `/* [STATE]/[INVARIANT]/[BOUNDARY] */` 学习注释或独立补丁文件，并在本文件说明，不伪装成上游。
- **阅读中自问**：
  - 为什么 RECV 必须先于 SEND post？（RQ 的生命先于数据）
  - READ 为什么不会污染对端 CPU？（rkey + REMOTE_READ 授权）
  - RoCEv2 的 IP 层是 L3，为什么仍说"RDMA 不改主机 CPU"？（报文组装在网卡，IP/UDP 头由网卡/驱动生成）
  - QP 一旦 ERROR 为何不可回 RTS？（RQ 内可能残留未完成的 READ/WRITE，回 RTS 会造成次序错乱）
- **工具**：本模块配套 `observations.md`（未写）可用 `ibstatus`、`ibv_devinfo`、`perftest`（ib_*）或 Wireshark 的 `udp.port==4791` 过滤观察 RoCEv2。