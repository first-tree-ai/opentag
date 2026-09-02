# 任务

> Canonical source: [tasks.md](../tasks.md)
> Last synced with: 2026-09-02

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

因此群聊的 channel Session 永远不会作为 Task 出现；没有人回复的顶层请求是只有一条消息的话题。

## 执行记录与状态

Task 详情按时间倒序列出话题内消息的投递作为执行记录。两类投递被排除：thread Session 已拥有的消息在
channel Session 里的 `ambient` 旁听副本，以及因消息出现更新修订而过期的投递。并入进行中 Turn 的消息
显示为被该 Turn 吸收，并共享它的报告。

状态是话题的最新执行情况，按优先级判定：

1. `ended`：话题读取的那条 Session 已结束（Integration 被禁用）。
2. `running`：存在已接受但未报告的投递，且未过截止时间、其 Session 仍存活、同一 Session 里没有更晚被
   接受的 Turn。一个 Session 同时只跑一个 Turn，更晚的接受即证明前一个已结束而没有报告。
3. `queued`：存在仍在等待的投递。
4. 否则取最新执行的结果：`completed`、`failed`（含被拒绝的投递）或 `expired`（未处理即过期的投递，
   或超过截止仍未报告的 Turn）。

## 标题

Task 的标题来自根消息，沿用列表一直使用的推导方式：去掉路由语法、去掉被 @ 的 Bot、限制长度。存储在
话题的 thread Session 上（私聊则是 channel Session 上）的手动标题或生成标题会覆盖它。

`PATCH /api/v1/sessions/:id` 设置或清除手动标题。id 可以是 Task id，也可以是它的某条 Session；标题
写入 Task 读取标题的那条 Session。没有人回复的顶层群聊请求没有这样的 Session，返回 `404`。

## 内部 Session 与协作消息

Task 包含从 thread Session 或私聊 Session 继承了其作用域（频道与线程键，或私聊）的内部 Session，以及
群聊的 channel Session 在该话题某个 Turn 运行期间创建的内部 Session 及其后代。协作消息是话题自身的
Session 与这些内部 Session 之间交换的消息。

## 边界

- 出站消息不被观测，所以 Task 无法说明 Agent 是否回复了；它记录的是被要求做什么以及每个 Turn 如何
  结束。
- 群聊 channel Session 上崩溃的 Turn 会保持 `running`，直到该 Session 接受另一条投递或投递截止时间
  到期。
- 列表按请求从账户已存储的消息计算。汇总先决定分页，再由当页的行解析标题与 Session；非常大的账户
  之后可能需要话题键上的索引。
