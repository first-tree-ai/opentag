# 任务

> Canonical source: [tasks.md](../tasks.md)
> Last synced with: 2026-09-11

任务（Task）是账户拥有者对"有人在飞书或 Slack 里让 Agent 做的一件事"的只读视图。它是对已存储的入站
`ImMessage` 记录及其 `im_message_deliveries` 的投影；消息投递、Session 物化和 Agent Runtime 都不因它而
改变。出于兼容，Task 接口仍位于 `/api/v1/sessions`，但它的行是话题，不是 Session。

## 一个 Task 是什么

- 在群聊、频道或多人私聊里，一个 Task 是一个**话题**：根消息加上围绕它的回复链。话题键是
  `coalesce(线程根, thread_key, external_message_id)`。Slack 的 `thread_ts` 就是根消息自己的 id。飞书
  线程在提供方给出 `thread_id` 时按它归属，否则按 `root_id`；当回复携带的 `thread_id` 与其 `rootId`
  不同时，话题以根消息为键，使根消息与回复保持在一起。
- 在私聊里，整段对话是一个 Task。
- 只有在有人直接找过 Agent 之后，话题才成为 Task。Agent 只是旁听到的消息（`ambient` attention）是
  对话上下文，不是 Task，也不计数。
- Task id 是话题中最早那条已存储消息的 id。详情接口接受话题内任意一条消息的 id，并返回规范 id。
  `createdAt` 是根消息的时间。

因此群聊的 channel Session 永远不会作为 Task 出现；没有人回复的顶层请求是只有一条消息的话题。一旦话题中
有消息携带线程键，Task 就报告 `sessionKind: "thread"` 和线程键：在 Slack 和飞书普通群里是第一条回复，
在飞书话题群里根消息本身就带；私聊和没有人回复的请求报告 `sessionKind: "channel"` 且没有线程键，
Web 因此按它们所在的会话类型来标注。

## 执行记录与状态

Task 详情按时间倒序列出话题内消息的投递作为执行记录。两类投递被排除：thread Session 已拥有的消息在
channel Session 里的 `ambient` 旁听副本，以及因消息出现更新修订而过期的投递。并入进行中 Turn 的消息
显示为被该 Turn 吸收，并共享它的报告。

状态是话题的最新执行情况，按优先级判定：

1. `ended`：话题读取的那条 Session 已结束（Integration 被禁用）。
2. `running`：存在已接受但未报告的投递，且未过截止时间、其 Session 仍存活、同一 Session 里没有更晚被
   接受的 Turn。一个 Session 同时只跑一个 Turn，更晚的接受即证明前一个已结束而没有报告。
3. `queued`：存在仍在等待的投递。
4. 否则取最新执行的结果：`completed`、`failed`（含被拒绝的投递）、`cancelled`（账户在运行前撤回的排队
   投递）或 `expired`（未处理即过期的投递，或超过截止仍未报告的 Turn）。

详情中每条 Turn 的 `delivery.isRunning` 与列表使用同一个有效运行条件。Web 仅在该值为 true 时显示进行中，
不会从持久化的 `accepted` 推断仍在运行。已经不活跃且没有报告的 Turn，以及旧服务器未提供该字段的数据，
显示“暂无执行报告”。

## 标题

Task 的标题来自根消息，沿用列表一直使用的推导方式：去掉路由语法、去掉被 @ 的 Bot、限制长度，截断处以省略号标记。
存储在话题的 thread Session 上（私聊则是 channel Session 上）的手动标题或生成标题会覆盖它。

`PATCH /api/v1/sessions/:id` 设置或清除手动标题。id 可以是 Task id，也可以是它的某条 Session；标题
写入 Task 读取标题的那条 Session。没有人回复的顶层群聊请求没有这样的 Session，返回 `404`。

## 取消排队中的 Task

`POST /api/v1/sessions/:id/cancel` 撤回仍处于 `queued` 状态的 Task。id 可以是 Task id，也可以是它的某条
Session。撤回是全有或全无的：话题内所有待处理投递一起被置为过期并标注 `cancelled` 原因，其 `expiresAt`
设为取消的那一刻；否则一条都不动。投递 worker 只认领 pending 行，且只在过期行仍带有派发关联时才会恢复它，
因此被撤回的投递之后不会再被拾起。取消时刻就是被撤回投递的活动时间，也因此是话题的最新活动：响应返回刷新后
的 Task 摘要，状态为 `cancelled`——即使话题中更早的某个 Turn 在被撤回的消息到达之后才结束也是如此——并且在
话题里有更晚的 Turn 运行之前一直保持 `cancelled`。因此 `200` 始终意味着话题内所有排队投递都已撤回、Task 读作
`cancelled`；话题中有正在运行的 Turn，或有投递正被 worker 派发时，返回 `409` 且一条都不撤回。

只有排队中的 Task 才能取消。`running` 或已结束的 Task 返回 `409 TASK_NOT_QUEUED`；排队中的 Task 若其任何一条
待处理投递此刻正被 worker 派发，也会得到同样的答复——Runtime 可能已经在运行它，队列里的其余投递也随之保留，
而不是绕开它被撤回。检查和更新期间待处理行被锁定，因此取消进行中若有 worker 开始处理其中一条，整个取消同样
返回 `409`。Web 收到这个答复时刷新 Task 而不是报告失败，并根据刷新结果区分两种情况：已经离开队列的 Task 提示
"已不在排队中"；仍为 `queued` 的 Task（其消息正在投递给 Agent）提示未能取消，并保留取消按钮。成功时也同样依据
返回的状态给出提示。对已经 `cancelled` 的 Task 再次取消是无操作的成功，重复请求无害。

## 内部 Session 与协作消息

Task 包含从 thread Session 或私聊 Session 继承了其作用域（频道与线程键，或私聊）的内部 Session，以及
群聊的 channel Session 在该话题某个 Turn 运行期间创建的内部 Session 及其后代。协作消息是话题自身的
Session 与这些内部 Session 之间交换的消息。

## 边界

- Task 回复历史在 Turn report 带有快照时，使用该 Turn 捕获到的成功 Lark 出站回执。`finalText` 只是
  执行摘要，不能代替已发送回复。完整捕获中没有记录到发送、或旧报告没有快照时，显示准确的空状态或不可用，而
  不是“进行中”。不会把 Slack 当成 Lark 收集。发送回执不是已读回执。无论保留下多少条回复，部分捕获都会独立标记；截断提示及原生富文本、卡片详情可查看。回复随终态报告提供，不会从旧 Runtime 对话中补录。
- 群聊 channel Session 上崩溃的 Turn 会保持 `running`，直到该 Session 接受另一条投递或投递截止时间
  到期。
- Lark 回复不可用提示仅出现在飞书/Lark Task 中；Slack Task 保留执行摘要，不长期显示不受支持的捕获提示。
- 回复快照要求当前连接协商 `runtime.turnReport` v2。在 v2 下生成的报告遇到 v1 重连时保持持久化，
  重新协商 v2 后原样重放。v2 服务器对未协商的快照返回非致命的 `unsupported_capability` 报告结果。
- 列表按请求从账户已存储的消息计算。汇总先决定分页，再由当页的行解析标题与 Session；非常大的账户
  之后可能需要话题键上的索引。
