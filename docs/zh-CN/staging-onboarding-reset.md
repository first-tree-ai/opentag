# Staging onboarding reset

[English](../staging-onboarding-reset.md)

onboarding 是为从未跑过它的 Account 写的，因此一个 staging Account 天然只能免费走一遍。staging onboarding reset 提供了回头路：
它把**已认证的那个 Account** 恢复到真实的首次使用状态，从而可以从头再走一遍完整路径。

之所以需要它，是因为仅清除 setup 完成时间戳并不够。已有的 Computer enrollment、Agent、runtime readiness 和 IM binding 会立即
推进由事实推导出的 onboarding 流程，因此一个已完成的 Account 无法自行回到首次使用状态。

reset 在 production 不可用，也永远不会触及已认证 Account 之外的任何 Account。

只做界面层面的设计评审——文案、层级、状态表达——请用 `/internal/onboarding-v2`：它用 mock 后端渲染真实的 onboarding 页面，
既不需要 Account 也不需要 reset。

## 每个测试者使用自己的 Account

用你自己的身份登录 staging。新建的 Account 本身就处于首次使用状态，所以第一次完整体验不需要任何额外东西；reset 解决的是第二次。

不存在需要轮流使用的共享测试 Account，也没有任何配置。两个人可以同时跑 onboarding：各自只 reset 自己的 Account，各自注册自己的
Computer，而每一次飞书授权都会在测试租户中创建属于自己的应用，因此绑定之间不会冲突。

只剩一项共享成本。reset 会停用 OpenTag 这一侧的绑定，但无法删除它在飞书租户中创建的应用，因此重复运行会在租户里累积应用，需要
定期手工清理。

## 配置

无需配置。任何以 `OPENTAG_ENV=staging` 运行的部署都提供 reset，其他环境一律拒绝。

Server 强制执行的规则：

- 每个请求都必须完成认证；
- staging 之外的任何部署，响应都与路径不存在完全一致，且环境会在每个请求上重新确认，而不是信任路由注册这一事实；
- reset 始终作用于已认证 Account，不接受客户端选择的 Account；
- 除非该 Account 恰好独占一个活跃资源域，否则 reset 拒绝执行，因此它只可能作用于调用者自己的资源；
- reset 需要常规的浏览器 CSRF 保护。

`OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID` 过去用于指定唯一允许 reset 的 Account，现已废弃：仍然设置它的部署可以正常启动，该值被
忽略。

## 如何发起 reset

用你已经登录的浏览器会话发一个已认证请求即可：

```text
POST /api/v1/me/setup/reset
{ "mode": "all" | "reboard" }
```

在 staging 标签页的控制台里执行（会话 cookie 与 CSRF cookie 都已存在）：

```js
await fetch("/api/v1/me/setup/reset", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-OpenTag-CSRF": decodeURIComponent(document.cookie.match(/opentag_csrf=([^;]+)/)[1]),
  },
  body: JSON.stringify({ mode: "all" }),
});
```

返回 `204` 表示该 Account 已回到 setup gate 之外；刷新页面就会自动进入 `/onboarding`。

### `mode: "reboard"`

只清除 setup 标记，其他什么都不动。Account 已有的 Agent、Computer 与消息连接全部保留，因此下一次运行是「继续」而不是「首次」。
适合在不重建 Agent、不重新注册机器的前提下再看一遍 onboarding；不适合验证首次运行的行为，因为幸存的事实会把流程直接推过那些
本应创建它们的步骤。

### `mode: "all"`

把 Account 恢复到真实的首次使用状态。reset 分阶段执行且幂等：

1. 通过既有 Agent 生命周期挂起并删除每个未删除的 Agent，这会禁用 IM binding、清除加密的 IM 与 setup 凭据、结束活跃 Session
   并移除 runtime 配置；
2. 撤销未消费的 Computer connect code；
3. 撤销活跃的 enrollment 凭据与 Computer enrollment；
4. 关闭受影响的在线 Computer 连接；
5. 重新读取权威事实并校验；
6. 只有在校验通过后才清除 setup 完成时间戳。

由于该时间戳是最终提交标记，在校验之前失败的 reset 会让 Account 停留在应用内部，可以直接重跑。两名测试者同时 reset 作用于不同
Account、锁的是不同资源域，因此互不阻塞。

历史与身份数据会被保留：Account 及其 Google identity、已删除的 Agent 行、已禁用的 IM binding、已结束的 Session 与消息、
稳定的 Computer 身份，以及外部 Feishu Bot。这些数据之后都不会满足 onboarding 的活跃事实。

## 两次运行之间的本地 Computer

重复测试不需要删除或重建 `OPENTAG_HOME`。执行 `mode: "all"` 的 reset 之后：

1. 之前的 enrollment 与 machine token 失效；
2. Web 生成新的 Computer connect 命令；
3. CLI 复用稳定的物理 Computer 身份；
4. 新的 enrollment 凭据替换同一 Account 与 scope 下失效的凭据；
5. 既有 daemon 服务重启并重连。

这会验证 Computer 步骤、connect 命令、enrollment、readiness 与 Agent 创建。它刻意不重复验证首次安装 package、首次安装 daemon
服务，或每次都创建全新的本地 Computer 身份；需要覆盖这些时请使用干净的 VM 或 CI 主机。

## 两次运行之间的 Feishu

reset 会禁用 OpenTag 的 binding、清除加密凭据与 setup 上下文，并结束活跃 Session。它不会从外部 Feishu 测试租户删除 Bot 或
App，因为目前没有可靠的 provider 删除接口。

真实运行仍然验证扫码授权、binding 激活、已授予能力、handoff readiness 与 onboarding 完成。要测试真正全新的租户 App，请换一个
测试 Bot，或手动移除旧的外部 App。

## 人工 staging 验收

```text
用 mode "all" reset 你自己的 Account
→ 进入常规 onboarding
→ 使用既有本地 home 执行生成的 Computer connect 命令
→ 观察 Computer readiness
→ 创建 Agent
→ 在测试租户中完成 Feishu 授权
→ 观察 handoff readiness
→ 完成 onboarding
→ reset 并重复
```
