# 云端计费

云端模型调用和连通性测试使用已配置的自托管 LiteLLM 网关。公开 OpenTag 服务负责身份验证、网关请求、有界流式转发、用量捕获和统计。私有 `@opentag/cloud-billing` 包在应用进程内负责客户定价、额度准入、结算及 Stripe Checkout。两者使用同一 PostgreSQL 数据库；公开仓库管理 `billing` schema 和迁移。本地 Agent 保持现有执行和用量路径。

## 计量与定价

每次云端模型调用只有一条持久记录，包括账户、Agent、可选 Session、来源、网关标识、模型、请求 ID、Token 数量和结算状态。执行归属来自已验证授权及数据库关系；连通性测试使用已验证所有权的 Agent 和登录账户。账本不保存提示词或响应内容。

LiteLLM 返回 OpenAI 兼容用量。流式请求强制设置 `stream_options.include_usage=true`。输入总数包含缓存输入；推理 Token 已包含在输出总数中，不重复相加。可用模型需要经验证的 `max_input_tokens` 和 `max_output_tokens` 元数据；开启计费时还必须具有客户价格。在 LiteLLM 模型元数据中配置这些能力，并验证部署版本为每个模型返回的字段。

私有 `BILLING_PRICES` 配置按网关及模型标识提供每百万输入、缓存输入、输出 Token 的整数微美元费率。准入保存费率快照。结算计算 `(输入-缓存)*输入费率 + 缓存*缓存费率 + 输出*输出费率`，除以一百万，再通过整数运算一次性向上取整至微美元。调整价格只影响之后的调用。没有缓存计数的网关必须配置相同的普通输入和缓存输入费率；缓存折扣需要完整缓存计量。

账户和 Agent 云端用量读取同一调用账本。派发时保存执行来源，用于合并本地报告与云端账本；云端任务报告中的 Token 不重复加入聚合。任务数量及结果仍来自任务报告。账户用量包含连通性测试，提供 1、7、30、90 天总量及每日图表。未知数量显示为不完整数据。

## 额度与结算

在云端镜像中开启 `OPENTAG_CLOUD_BILLING_ENABLED=true`。准入在短数据库事务内锁定账户，应用已知付款阻断，检查可用额度及并发数量，并在联系 LiteLLM 前插入带价格的调用记录。余额等于已授予额度减去已结算扣款。每账户默认一次性赠送 1 美元，默认最多并发两次调用。关闭计费时仍使用相同网关和账本，不扣额度。

公开模型服务直接将规范化用量写入账本。结算在同一事务内锁定账户和调用记录，读取已记录用量并记录扣款。重复观察、付款入账及结算均不会重复扣款或发放额度。已准入调用可能超出剩余余额；实际扣款最多为可用额度，计算价格与扣款的差额由 OpenTag 承担。公开执行授权限制输出最多 8,192 Token。请求体、响应、超时和并发限制约束风险，但超时本身不保证固定美元上限。接受真实付款前验证各模型的风险。

确认尚未发送的请求以零扣款结束。已发送而缺少最终用量的请求进入 `pending_usage`，阻止该账户继续发起计费调用，但不影响充值和余额查询。公开后台任务通过 `x-litellm-call-id` 和响应 ID 查询 LiteLLM `/spend/logs?request_id=...`，持久化重试间隔从 30 秒递增至一小时。空结果、多义记录、失败记录和不完整用量保持待处理。日志异步写入；如需单独日志访问凭证，配置仅服务端使用的 `OPENTAG_CLOUD_MODEL_USAGE_KEY`，否则使用模型凭证。验证部署版本的权限、请求关联和缓存字段。

启动时在云端就绪前将遗留运行中计费调用标记为待处理。结算失败的调用在执行超时加宽限期后进入恢复流程。操作员可在已构建的私有仓库中使用应用环境运行 `node scripts/write-off.mjs <call-id> <reason>`，审核后豁免未解决调用并保存原因。更换网关标识或地址前，先停止活动调用并解决待处理记录。

## 付款

账户展示包含起始额度及购买额度的统一美元余额，支持 10 至 1,000 美元自定义充值，精确到美分。Stripe 托管 Checkout 返回 `/account`；只有已验证的已付款会话增加额度。签名 Webhook 为 `/stripe/webhook`，注册 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`charge.refunded`、`charge.dispute.created`。退款只撤回一次购买额度；退款及争议阻止继续消费，等待操作员审核。先于入账到达的事件持久保存。付款入账和余额查询不依赖模型提供商可用性。

在应用环境配置 `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`BILLING_PRICES`，以及可选的 `BILLING_FREE_CENTS`、`BILLING_MAX_CONCURRENT_PER_ACCOUNT`。验收使用 Stripe 测试模式。本 MVP 不包含自动充值、订阅、请求预留或计费管理界面。

## CapRover 部署

公开仓库的 `Docker`、`Deploy Staging`、`Deploy Runner` 工作流同时发布应用及计费包。`cloud-billing.json` 固定私有包提交。为 `first-tree-ai/opentag-billing` 配置只读 Contents 权限的 `OPENTAG_BILLING_READ_TOKEN`；可信 main 构建检出该版本，对应用运行包检查及测试，然后打入 `ghcr.io/first-tree-ai/opentag:<应用 SHA>`。镜像记录两个源码版本。PR 和默认本地镜像无需私有仓库访问权限。生产镜像包含私有代码，允许公开；运行时密钥保留在 CapRover。

开启云端身份、云端模型、计费及 `OPENTAG_AUTO_MIGRATE=true`。启动先应用公开迁移，再构造服务。暂存流程发布应用及 CLI/Runner，部署应用，再激活匹配 Runner。`/cloud-readyz` 验证应用及计费版本；`/readyz` 独立于计费可用性。

使用单应用副本、无 predeploy 函数、stop-first 更新及回滚。`UpdateConfig` 设置为 `{"Order":"stop-first","Parallelism":1,"FailureAction":"pause"}`，`RollbackConfig` 为 `{"Order":"stop-first","Parallelism":1}`，`TaskTemplate.ContainerSpec.StopGracePeriod` 至少为 `(OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS + 30000) * 1000000` 纳秒。默认 600 秒超时要求 `630000000000`。这避免启动恢复将其他活动进程的调用误判为遗留任务。`OPENTAG_BUILD_REVISION` 和 `OPENTAG_BILLING_REVISION` 由镜像提供。备份共享数据库；已应用迁移需要兼容应用镜像，优先使用向前修复。

参考：[LiteLLM 用量](https://docs.litellm.ai/docs/completion/output)、[LiteLLM 费用日志](https://docs.litellm.ai/docs/proxy/cost_tracking)、[Stripe 入账](https://docs.stripe.com/checkout/fulfillment)。
