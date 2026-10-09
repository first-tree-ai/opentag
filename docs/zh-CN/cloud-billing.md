# 云端计费

云端模型调用和连通性测试通过 `llm-router`，由它在内部调用自托管 LiteLLM。Router 负责规范化 Provider 用量、持久化请求状态及核对未完成请求。OpenTag 负责可信的账户和 Agent 归属、有界转发及用量统计。私有 `@opentag/cloud-billing` 包在 OpenTag 进程内负责客户价格、额度和 Stripe Checkout。应用和计费包共用 PostgreSQL；公开仓库管理 `billing` schema 和迁移。本地 Agent 使用现有执行和用量路径。

## 用量与价格

发送请求前，OpenTag 创建一条持久化调用记录，包含账户、Agent、可选会话、来源、网关、模型及客户价格快照。调用 UUID 是 Router 的 `Idempotency-Key`。执行归属来自经验证的授权和数据库关系；连通性测试使用已验证所有权的 Agent 和已登录账户。账本不保存提示词或响应正文。

OpenTag 转发模型响应，不解析 Token 用量。完成或中断后，它使用模型调用的同一服务端 Router 租户凭证查询 `GET /v1/requests/usage?idempotency_key=<调用 UUID>`。Router 返回关联的请求 ID、模型及三种状态之一：包含全部四类 Token 计数的 `complete`、`no_charge` 或 `pending`。带 `request_not_found` 的 404 表示用量未知，不能当作免费调用。OpenTag 验证身份、模型及计数后才结算。

规范化输入总数包含普通输入、缓存读取和缓存写入。缓存读取与写入是输入中互不重叠的子集。输出包含推理 Token。Router 统一规范化计数并处理 Provider 响应格式。可用模型需要经验证的输入和输出限制；模型可用性与权限由网关管理。

客户费率保存在私有计费仓库的 `src/plans.json`，按套餐 ID 配置。每个套餐包含 `input`、`cachedInput` 和 `output`，用最多六位小数的美元字符串表示每百万 Token 的价格。缓存读取享受折扣；缓存写入按普通输入计费。每个计费账户拥有 `plan_id`，默认值为 `standard`。费率适用于所有网关和模型；调用记录仍保存网关与模型用于归属统计。操作员可添加费率套餐，并在构建后的私有 checkout 中执行 `node --env-file=/path/to/opentag/.env scripts/set-plan.mjs <account-id> <plan-id>` 来分配套餐。分配操作使用账户锁，保留现有额度。套餐不引入订阅、客户选择界面或模型访问规则。

计费包在启动时验证所有套餐，要求存在 `standard`，并精确转换为整数微美元。账户被分配未知套餐时拒绝新调用。结算计算 `(input-cached)*input_rate + cached*cached_rate + output*output_rate`，除以一百万，并用整数运算统一向上取整。每次调用准入时保存账户费率，因此套餐与费率修改只影响后续调用。客户费率独立于 Router 的 Provider 成本账本；应结合所提供的模型审核费率，避免昂贵模型按低于成本的价格销售。更新费率时，提交私有套餐文件，更新应用的 `cloud-billing.json` 固定版本，再部署应用。套餐文件不进入公开源码，但会打包进生产镜像。

账户和 Agent 云端统计读取同一调用记录的最终计数，包括关闭客户计费时的调用。本地报告与云端账本按发送时保存的执行来源合并；云端任务报告中的 Token 不重复计入。任务数量及结果仍来自任务报告。账户用量包含连通性测试，支持 1、7、30 和 90 天总量及每日图表。缺失计数视为不完整数据。

## 额度与结算

在云端镜像中开启 `OPENTAG_CLOUD_BILLING_ENABLED=true`。准入在短事务中锁定账户，选择套餐费率，应用付款阻断，检查可用额度、未解决调用及并发数量，并在发送前插入带价格快照的调用。余额等于已授予额度减去最终扣款。每账户默认一次性赠送 1 美元，最多并发两次调用。关闭计费时，云端调用仍使用相同 Router 状态及统计路径，不扣额度。

结算锁定账户和调用，在同一事务内保存全部最终计数及额度扣款。重复结算不会再次扣款或修改已结束的计数。已准入调用可能超过剩余额度；扣款上限为可用余额，OpenTag 承担差额。执行授权将输出限制为最多 8,192 Token。请求体、响应、超时和并发限制控制风险；超时本身不能保证金额上限。接收真实付款前需验证所提供模型的风险。

发送前取消、Router 确认的发送前拒绝（`X-Router-Dispatch: not_dispatched`），以及 Router 返回的 `no_charge` 均以零扣款结束。OpenTag 每次操作使用新键，模型请求只发送一次，未知执行不会重新发送。未知或待核对用量进入 `pending_usage`，阻止该账户继续发起计费调用，但不影响充值和余额查询。公开后台任务仅重试状态查询，持久化间隔从 30 秒递增至一小时。中断执行和缺失用量在 Router 中核对，OpenTag 读取其最终状态。

启动时在云端就绪前将遗留调用标为待核对，包括关闭计费时的调用。超过请求超时加宽限期的执行中记录也进入待核对状态。更换网关身份或地址前，应排空活动调用并处理待核对记录。操作员可在构建后的私有 checkout 中，使用应用环境执行 `node scripts/write-off.mjs <call-id> <reason>`，豁免已审核但无法解决的客户调用；原因会保存。

## 付款

账户页显示一个可用美元余额，包含起始额度和购买额度，支持以美分精度自定义充值 10 至 1,000 美元。Stripe 托管 Checkout 返回 `/account`；只有经验证的已付款会话增加额度。签名 Webhook 地址为 `/stripe/webhook`，需注册 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`charge.refunded` 和 `charge.dispute.created`。退款只移除一次购买额度；退款和争议阻止云端消费，等待操作员审核。入账前收到的事件持久化保存。Provider 可用性不影响入账或余额查询。

在应用环境配置 `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`，可选配置 `BILLING_FREE_CENTS` 和 `BILLING_MAX_CONCURRENT_PER_ACCOUNT`。费率来自打包的私有套餐文件。验收使用 Stripe 测试模式。自动充值、订阅、请求预留及计费管理界面不在 MVP 范围内。

## CapRover 部署

公开仓库的 `Docker`、`Deploy Staging` 和 `Deploy Runner` 工作流一起发布应用和计费包。`cloud-billing.json` 固定私有包提交。配置仅可读 `first-tree-ai/opentag-billing` Contents 的 `OPENTAG_BILLING_READ_TOKEN`；可信 main 镜像构建检出该提交，针对应用运行检查及测试，再打包进 `ghcr.io/first-tree-ai/opentag:<应用 SHA>`。镜像记录两个源代码版本。PR 和默认本地镜像不需要私有访问权限。生产镜像可能公开，包含私有包代码；运行时凭证保存在 CapRover。

先部署 Router 用量端点，并使用 OpenTag 租户键验证（`llm` scope）。`OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL` 指向其 `/v1` 地址，`OPENTAG_CLOUD_MODEL_MASTER_KEY` 使用该租户键。验证每个模型的最终、待核对、缺失及拒绝状态，再开启云端身份、云端模型、计费及 `OPENTAG_AUTO_MIGRATE=true`。启动先运行公开迁移再创建服务。Staging 工作流发布应用和 CLI/Runner，部署应用后启用匹配的 Runner。`/cloud-readyz` 验证应用和计费版本；`/readyz` 独立于计费可用性。

使用单应用副本，无 predeploy function，更新和回滚均先停止旧实例。`UpdateConfig` 为 `{"Order":"stop-first","Parallelism":1,"FailureAction":"pause"}`，`RollbackConfig` 为 `{"Order":"stop-first","Parallelism":1}`，`TaskTemplate.ContainerSpec.StopGracePeriod` 至少为 `(OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS + 30000) * 1000000` 纳秒。默认 600 秒超时需要 `630000000000`，避免启动恢复误将其他活动进程调用视为遗留调用。让镜像提供 `OPENTAG_BUILD_REVISION` 和 `OPENTAG_BILLING_REVISION`。备份共享数据库；已运行的迁移需要兼容镜像，优先向前修复。

## 验收测试

使用独立 Router PostgreSQL/Redis、OpenTag 测试数据库及 Stripe 测试模式。验证普通和流式响应记录与 Router 完全一致的计数（包括缓存读写），并对应一次额度扣款。重复结算后计数和余额应不变。中断流式响应，检查待核对状态，在 Router 完成核对后确认 OpenTag 后台任务结算同一调用且没有再次执行模型。确认拒绝请求不扣款、租户键无法读取其他租户用量、异常或未知用量保持待核对，以及关闭计费时云端用量仍可见。在调用尚未结束时分配第二个测试套餐：未完成调用保留原费率，新调用使用新套餐，其他账户仍使用默认套餐。确认不同模型使用同一套餐费率，未知套餐拒绝新调用但不影响结算。最后完成一次测试 Checkout 并重放签名 Webhook，验证只授予一次额度。
