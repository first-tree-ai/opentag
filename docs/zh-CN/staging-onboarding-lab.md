# Staging Onboarding Lab

[English](../staging-onboarding-lab.md)

Onboarding Lab 是仅限 staging 的页面，用于迭代首次使用体验。它为一个共享的 staging Account 提供两件事：用于快速设计评审的
固定 onboarding 界面状态，以及可重复的 reset——把该 Account 恢复到真实的首次使用状态，从而可以再次走完整条 staging 路径。

之所以需要它，是因为仅清除 setup 完成时间戳并不够。已有的 Computer enrollment、Agent、runtime readiness 和 IM binding 会立即
推进由事实推导出的 onboarding 流程，因此一个已完成的 Account 无法自行回到首次使用状态。

Lab 在 production 不可用，也永远不会 reset 除已认证 Account 之外的任何 Account。它的两半门禁不同：Scenario Preview 不读取也不
写入任何内容，因此在已配置的 staging 部署上，任何已登录 Account 都可以打开；破坏性的 reset 仍然只属于那个被配置的 Lab Account。

## 共享 staging Account

准备一个企业管理的 Google 测试身份，例如 `onboarding-test@company.example`，并把登录凭据保存在团队密码管理器中。禁止写入本仓库
或部署配置。

该 Account 是共享且串行使用的沙箱。页面会给出提示，但并发只是团队约定：reset 之前先确认当前谁在测试。任何浏览器都可以使用；
隐私窗口或独立浏览器 profile 只是为了同时保留个人 staging 登录的便利手段。

## 配置

在 staging 部署中增加一个可选的 Server 设置：

```bash
OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID=00000000-0000-0000-0000-000000000000
```

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID` | 空 | 允许使用 staging Onboarding Lab 的 Account UUID |

Server 强制执行的规则：

- 取值必须是 Account UUID；空值表示 Lab 未配置；
- 该设置只在 `OPENTAG_ENV=staging` 时有效，因此在 production 配置会导致 Server 启动失败；
- 未配置时完全不注册任何 Lab 路由；
- 每个请求都必须完成认证；在已配置的 staging 部署上，任何 Account 都可以读取 Lab 并查看 Scenario Preview，响应会说明该 Account
  是否拥有 reset；
- 未配置的部署，以及 staging 之外的任何部署，对两种请求的响应都与页面不存在完全一致；
- 只有被配置的 Account 可以 reset；其他 Account 得到的拒绝与页面不存在完全一致；
- reset 始终作用于已认证 Account，不接受客户端选择的 Account；
- reset 需要常规的浏览器 CSRF 保护。

获取 Account UUID 的方法：用测试身份登录一次 staging，从 `GET /api/v1/me` 读取 `user.id`，然后带上该设置重启 Server。

## 使用 Lab

直接打开该路由并加入书签；它刻意不出现在产品导航中：

```text
https://<staging-host>/internal/onboarding-lab
```

该路由位于已认证路由之内、setup 完成 gate 之外，因此在 reset 后真实 onboarding 卡住时仍然可以打开。

### Scenario Preview

Preview 使用固定事实渲染生产 onboarding 页面，复用与生产相同的状态推导与呈现。被选中的 fixture 是唯一保留的状态，且保存在 URL 中：

```text
/internal/onboarding-lab?scenario=computer-offline
```

场景覆盖：全新 Account、Computer 离线、Provider 不可用、可创建 Agent 的可运行路由、Agent runtime 路由丢失、等待 Feishu、
Feishu 授权进行中、setup 完成，以及加载失败。

Preview 不发出任何请求，也不产生任何持久状态。它用于界面层级、文案与状态表达，而不是交互。它不会模拟 Computer daemon、
Feishu 协议或伪造 Server，因此需要点击验证时请使用下面的真实 reset。

### 真实 reset

`Reset shared account and start onboarding` 会要求一次确认，然后 reset 共享 Account 并进入常规 `/onboarding` 路由。
reset 分阶段执行且幂等：

1. 通过既有 Agent 生命周期挂起并删除每个未删除的 Agent，这会禁用 IM binding、清除加密的 IM 与 setup 凭据、结束活跃 Session
   并移除 runtime 配置；
2. 撤销未消费的 Computer connect code；
3. 撤销活跃的 enrollment 凭据与 Computer enrollment；
4. 关闭受影响的在线 Computer 连接；
5. 重新读取权威事实并校验；
6. 只有在校验通过后才清除 setup 完成时间戳。

由于该时间戳是最终提交标记，在校验之前失败的 reset 会让 Account 停留在 onboarding 之外，可以直接重跑——页面会停留在 Lab 并提供
重试。两名测试者同时 reset 可能导致其中一个请求失败；重试即可收敛。

历史与身份数据会被保留：Account 及其 Google identity、已删除的 Agent 行、已禁用的 IM binding、已结束的 Session 与消息、
稳定的 Computer 身份，以及外部 Feishu Bot。这些数据之后都不会满足 onboarding 的活跃事实。

## 两次运行之间的本地 Computer

重复测试不需要删除或重建 `OPENTAG_HOME`。reset 之后：

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
reset 共享 Account
→ 进入常规 onboarding
→ 使用既有本地 home 执行生成的 Computer connect 命令
→ 观察 Computer readiness
→ 创建 Agent
→ 在测试租户中完成 Feishu 授权
→ 观察 handoff readiness
→ 完成 onboarding
→ reset 并重复
```
