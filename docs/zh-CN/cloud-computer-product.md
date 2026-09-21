# Cloud Computer 产品与资源控制

权威来源：[英文文档](../cloud-computer-product.md)。同步日期：2026-09-21。

Cloud Computer 是账号的逻辑身份，固定在线不表示物理 Instance 或模型已就绪。继续复用 Agent、Session 数据模型；每个 Agent Session 对应一个 Sandbox，最多绑定一个当前 Instance。Cloud 使用 Pi、1 vCPU／1 GiB。创建 Agent、打开设置不分配 Instance。Context Tree 可选，仅连接已有授权仓库。保留 Local 接入。

## 可用性与状态

复用 `OPENTAG_CLOUD_IDENTITIES_ENABLED` 作为默认关闭的总开关，同时控制身份与 Runner。
仅保留 `OPENTAG_CLOUD_MODEL_ENABLED` 作为第二个开关，便于暂停模型请求时保留工作区保存和
资源释放能力。总开关关闭时三项能力全部关闭；开启时要求完整 Runner 配置。
旧 `OPENTAG_CLOUD_RUNNER_ENABLED` 仅进行升级冲突校验，不再控制运行行为，参见[升级规则](./cloud-runner-execution.md)。前端不增加开关或独立隐藏设置：直接使用已有
可用性接口，未开放或不可用时保留灰色禁用的 Cloud 选项，不选中它，也不影响 Local 创建。

`GET /api/v1/computers/cloud` 只读查询部署可用性；相同地址的 `PUT` 幂等取得本账号 Computer，再由已有创建 Agent API 以 `runtimeProvider=pi` 绑定。Cloud setup 使用服务端配置和 IM 授权，不等待本地 daemon，也不伪造 CLI 检测结果；真正执行仍须通过 Runner 就绪与当前执行授权。

`GET /api/v1/agents/:agentId/cloud` 是按账号授权的只读数据库投影：

- 账号占用包含所有仍被跟踪的分配，包括删除尚未确认的资源。
- Agent 总数覆盖 IM 与内部 Session，不随列表分页变化。
- `limit` 默认 20、最大 100；UUID `cursor` 按 Session ID 分页。`sessionId` 筛选不能与 cursor 同用，均不能改变归属范围。
- 处理中数量表示已接收但未结束的工作；Runner 断线时行状态为未知，不推断进程已停止。Session 同时存在当前工作和等待输入时，可同时计入等待与处理中。
- 行状态只含生命周期、generation、认证连接和安全操作，不暴露资源名、存储地址或原始云端诊断。
- 已打开且可见的页面复用原有 30 秒刷新，包括空闲页面，以便发现新到达的 IM 任务；隐藏页面不进行定时轮询。
- 查询不调用 GCP／GCS，不启动实例、恢复工作目录或签发凭证。读取失败不能显示为零或空列表。

任务完成与环境保存是独立事实。任务完成但保存失败，仍保留已完成结果。不以旧归档推断最后保存时间或当前修改已全部保存。任务／Token 统计**仅包含 IM 任务**，内部 Session Token 暂不持久化；环境统计覆盖两类 Session。

## 资源准入

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT` | `3` | 每账号最多占用的实例数 |
| `OPENTAG_CLOUD_RUNNER_MAX_INSTANCES` | `20` | 配置的平台资源范围内最多占用的实例数 |

在原有分配入口预留新增资源前，通过短 PostgreSQL advisory 事务锁串行计数与预留；网络操作位于事务外。创建结果未知、删除未确认、保存失败均保留占位。已有实例、同账号复用、清理不额外占位。降低上限不会终止已有工作。该限制控制并发，不是模型和存储总费用封顶。

满额时 IM 留在原有有界可靠队列；显式 start 返回 `CLOUD_CAPACITY_EXCEEDED`；内部子任务在执行前持久化 `unreachable` 与 `cloud_capacity_exceeded`，容量恢复后可重试同一消息及子 Session，不会在父任务持有资源时自动无限等待。不新增队列、配额表、资源池或生命周期状态。继续沿用空闲回收。

## 恢复与释放

复用任务取消和 Sandbox stop。保存释放须确认归档持久化与物理删除；保存失败保留资源并允许重试。保存与丢弃请求都须提交当时的 `environmentGeneration`，旧页面不能停止新一代资源；显式丢弃还须二次确认。请求超时先查询状态，不自动重放破坏性操作。Runner 控制服务保持启用时，Agent／Session 停止后仍可读取及清理。完全关闭 Cloud Runner 会同时移除控制接口，因此关闭前须先保存并释放资源；模型不可用不需要关闭控制服务。

账号被停用时仍沿用现有认证拒绝，不能通过浏览器自助清理；其资源继续计入占用，由原有运行时清理或运维处理。Agent 暂停、Session 结束不等于账号停用。

## 发布与验收

使用[统一 CLI／Runner 发布](./cloud-runner-release.md)，不引入版本服务。核对实际 Server 源码、Runner digest／版本／源码、`/readyz` 目标证明与迁移 hash。构建成功不代表发布；写入后 workflow 失败也不代表写入未发生，重试前须读取真实状态。

开放入口前验证真实 PostgreSQL 并发准入、跨账号拒绝、Local 创建、IM 授权／撤权、旧 generation 丢弃，以及写入成功后刷新失败。真实组合验收还须指定 IM 会话和授权测试仓库：合成消息、本地 Git 不代表 Slack／飞书送达或 GitHub App 发布。记录源码／digest、Instance 身份、归档及清理回执。共享 staging 变更与回滚遵守部署授权，代码测试不自动授权切换共享环境。
