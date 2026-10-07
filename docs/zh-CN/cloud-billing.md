# 云端计费 MVP

云端计费为可选功能，默认关闭。本地 Agent 沿用现有的提供商凭据和执行路径。开启计费后，托管云端模型调用及云端 Agent 连通性测试会消耗账户的预付额度。

私有 `@opentag/cloud-billing` 包负责定价、Stripe Checkout、加密的账户级 OpenRouter 密钥和持久化额度记录。它在云端应用进程内运行，使用相同的 PostgreSQL 数据库 URL。OpenRouter 统计 Token 用量和成本。公共仓库负责模块接口、身份验证、云端请求转发、账户界面以及数据库结构和迁移。关闭计费时，公共构建不依赖私有包。

生产云端镜像包含私有包代码，可以公开发布。私有源码仓库并不能隐藏镜像中的代码；提供商凭据和定价配置仍作为运行时设置保管。以后可以改用私有镜像，无需重新引入独立服务。

## 启用

公共 Docker 工作流将应用及固定版本的私有计费包构建成一个云端镜像。在现有 Cloud Runner 和云端模型配置之外，设置 `OPENTAG_CLOUD_BILLING_ENABLED=true`。在 CapRover 应用中添加计费包所需的加密、OpenRouter 管理、Stripe、定价和欢迎额度配置。无需计费服务 URL、服务 Token 或单独的数据库凭据。设置 `OPENTAG_AUTO_MIGRATE=true`，应用启动先执行公开 Drizzle 迁移，再初始化计费模块。计费表位于 `billing` schema，引用 `public.users.id`。

Stripe 的签名 Webhook 使用应用的 `/stripe/webhook`；Checkout 返回 `OPENTAG_PUBLIC_URL` 下的 `/account`。使用真实付款前，请遵循私有仓库 README 和下方部署说明，并在 Stripe 测试模式下验证。模型目录仍来自现有服务端 Router 目录，使用获准的 OpenRouter 模型 ID 及能力。

账户界面仅显示包含初始额度及已购额度的美元可用余额，以及自定义金额充值表单（10 至 1,000 美元，精确到美分）。界面不显示定价细节或逐条计费记录。“查看用量”打开账户级云端用量页面，显示过去 1、7、30 或 90 天的模型调用总数、Token 总量及每日趋势。统计来自计费账本中的所有云端调用（包括连通性测试），不包含本地用量。未知 Token 数量不计入已测量数据，并提示数据不完整。Checkout 返回账户页面后，只有经过验证的 Stripe 已付款 Webhook 才会增加额度。付款入账不依赖 OpenRouter 可用性；后台任务更新密钥权限，每个新请求都会检查持久化余额及付款阻断状态。余额查询仅使用已入账额度及已知消耗，不调用 OpenRouter，也不创建密钥。显示值可能短暂落后于提供商计量；云端请求仍会在准入前对账。付款入账期间余额会自动刷新。欢迎额度为一次性的美元额度，实际可用 Token 数量取决于模型。

余额查询及充值使用经过身份验证的用户账户；执行请求使用经过验证的 Sandbox、Session 和 Agent 关系推导账户归属。浏览器写操作保留现有 CSRF 防护。托管连通性测试使用调用者的已认证账户。启用计费后，计费模块故障会拒绝云端请求，不会退回平台密钥。关闭计费开关会恢复现有的未计费云端路径，因此开始销售额度后应保持开启。

## MVP 限制

本版本使用手动预付美元充值、固定成本系数和每账户一次欢迎额度，包含重复付款保护、密钥加密、持久化用量记录、缺失生成记录对账，以及退款和争议后的账户阻断，供运营人员审核。该计费数据库的价格系数不可更改。不包含自动充值、订阅、严格的请求级额度预留、计费管理界面、自动退款审核或随时间调整加价的机制。

额度消耗取 OpenRouter 密钥累计用量与已报告单次费用之和的较大值，并持久保存已观察到的消耗。单次费用入账后即可消耗额度，无需等待累计用量更新；累计用量也覆盖中断的流式请求。缺失的单次费用会独立于 Token 统计进行对账。即使数量不可用，有效费用仍会入账；未知数量保留为不完整数据，不会触发无限重试。账户同步及失败的生成记录查询使用持久化指数退避，从 30 秒增长至一小时，使较新的记录仍可继续处理。新增额度、付款阻断及用量会使受影响账户立即具备同步资格。流式写入仅保存首次生成记录 ID 及变化后的用量，无需逐个 Token 片段写入。超额消耗由 OpenTag 承担，不成为用户债务。并发、输出、请求体、响应及超时限制可约束风险，但无法保证跨模型及提供商计量延迟下固定的美元超额上限。启用真实付款前，需使用生产模型目录及 Stripe 测试模式验证风险范围。

云端代理和计费包共用请求验证及输出预算限制逻辑。传输限制使用现有应用配置 `OPENTAG_CLOUD_MODEL_MAX_REQUEST_BYTES`、`OPENTAG_CLOUD_MODEL_MAX_RESPONSE_BYTES` 及 `OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS`（默认分别为 8 MiB、16 MiB 及 600 秒）；连通性测试传入较短的限制。计费包不再有单独的传输配置。

提供商行为说明参见 [OpenRouter 限制](https://openrouter.ai/docs/api_reference/limits)和 [Stripe 入账处理](https://docs.stripe.com/checkout/fulfillment)。

## CapRover 部署

部署保留在公共 OpenTag 仓库，沿用现有 `Docker`、`Deploy Staging` 和 `Deploy Runner` 工作流。不再使用私有部署工作流、独立云端发布清单或部署权限委托设置。`cloud-billing.json` 固定私有包的具体提交；更新该文件即可随应用发布计费变更。

在公共仓库配置 `OPENTAG_BILLING_READ_TOKEN` Secret，仅授予 `first-tree-ai/opentag-billing` 的 Contents 读取权限。只有受信任的 main 提交镜像任务会检出私有源码，且不保留凭据。任务使用正在构建的应用验证固定版本包的检查及测试，再将其打包到普通 `ghcr.io/first-tree-ai/opentag:<应用 SHA>` 镜像。镜像记录应用和计费版本。PR 构建及本地默认 Docker 目标无需私有仓库权限，仅构建不含计费包的应用；受信任构建使用 `cloud` 目标及命名 `billing` 构建上下文。运行时提供商凭据不会进入构建。

沿用公共仓库现有 CapRover/GCP 环境凭据。在同一个 CapRover 应用配置计费密钥，预发布环境使用 Stripe 测试密钥。启用云端身份、云端模型、计费及自动迁移。现有预发布流程等待应用镜像及 CLI/Runner 发布，先部署应用，再激活匹配的 Runner。Runner 部署工具读取所选应用提交中的计费版本，包括手动回滚，并要求激活前后 `/cloud-readyz` 确认两个源码版本。计费初始化失败会阻止激活。普通 `/readyz` 保持独立，计费故障不会影响本地使用。迁移仍在应用启动时执行。

应用使用单副本、禁用 predeploy function，并先停止旧实例再启动新实例。在 CapRover service update override 中将 `UpdateConfig` 设为 `{"Order":"stop-first","Parallelism":1,"FailureAction":"pause"}`，`RollbackConfig` 设为 `{"Order":"stop-first","Parallelism":1}`，`TaskTemplate.ContainerSpec.StopGracePeriod` 至少为 `(OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS + 30000) * 1000000` 纳秒。默认 600 秒超时需要 `630000000000`。计费准入锁仅在进程内有效，因此 Runner 工具会验证这些要求。替换可能短暂中断云端服务。不要覆盖 `OPENTAG_BUILD_REVISION` 或 `OPENTAG_BILLING_REVISION`，版本应来自镜像。

在应用 `/stripe/webhook` 注册 Stripe 事件 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`charge.refunded` 和 `charge.dispute.created`。发布时保留加密密钥并单独备份，同时备份整个共享 PostgreSQL 数据库。应用启动要求迁移日志完全一致，因此旧镜像不能回滚已应用的迁移；优先向前修复。销售额度后保持计费开启。添加这些文件不会配置或部署真实环境。
