# 在 Slack 中创建 Agent 并绑定独立 Slack App

[English](../slack-agent-provisioning.md)

同步日期：2026-10-15。

原 Agent 通过官方 Slack CLI 准备一个独立 App，然后以 Session proof 和本次 Account 操作码，发送一次创建并绑定请求。操作码不能兑换 Account access/refresh token。不新增数据库表、字段、流程记录或永久委派。

下文 `opentag` 应替换为当前环境的 CLI 名称，命令在托管 Session 内运行。普通 `agent create` 继续使用 Account 登录；普通 `slack api` 继续走原 Bot 的消息代理。

## 准备 Slack

1. 在上下文保留同一个 creationIntentId、目标 Team、创建配置和 App ID。新 Agent 固定使用来源 Agent 的 Runtime Provider 和 Session proof 验证的当前 Computer；Cloud 必须显式选择模型。名称不能证明 App 归属；创建结果不确定时不能重复创建。
2. `opentag slack home` 返回私有管理目录。Cloud 使用 `/tmp/opentag/slack-management`，位于每轮 HOME 和归档 workspace 之外；Local 使用 `<OpenTag home>/slack-management`。原生 CLI 配置在 `config/`，每次操作在 `project-<creationIntentId>/`，所有管理命令传同一个 `--project-dir`，临时文件也留在该目录。同 Team 的另一 App 不复用已绑定项目。管理命令顺序执行。Local 解析现有账户级原生 Provider CLI 启动器，绕开 PATH 上的 Turn 消息启动器；仅为带 proof 的可见 Session 预建这个0700目录并授予其写权限，不授予整个 OpenTag home 的写权限。
3. 没有可用管理登录时运行 `opentag slack manage -- auth login --no-prompt`。用户在 Slack 执行返回的 `/slackauthticket` 命令，检查权限后回传 challenge；再运行 `opentag slack manage --project-dir project-<intent> -- auth login --ticket <ticket> --challenge <challenge>` 完成同一 ticket。此协议不使用 localhost 浏览器回调，用户可在自己的设备操作；实际异机验收仍待完成。
4. 用 `opentag slack manifest --creation-intent <uuid> --display-name <name>` 生成初始 Manifest，复用名称规则、18 项 Bot scope 和可写 App Home，暂不开事件或交互回调。
5. 先校验同一 Manifest，再运行 `opentag slack manage --project-dir project-<intent> --team <team-id> --output-file project-<intent>/create-response.json -- api apps.manifest.create --json <manifest-request-json>`。JSON 请求的 `manifest` 字段是序列化后的 Manifest。输出路径相对私有管理目录，或为其内部的绝对路径。创建响应含 Signing Secret，不打印到聊天或普通日志。

管理 raw API 命令必须指定 `--team` 和 `--output-file`。封装清除消息代理 handle 和代理路由，先运行原生 `auth list` 让官方 CLI 续期，再读取该 Team 最新原生凭证，仅传给本次进程；检查 JSON 的 `ok`，不只检查退出码。不另存 refresh token，不引入刷新服务。官方 CLI 可能在 JSON 前输出展示文字，捕获 hook 会处理这种前缀。

查询原生 API 帮助使用 `opentag slack manage -- api --help` 或 `-h`，不需要 `--team` 或 `--output-file`，也不刷新或读取管理凭证。

## 原生管理授权边界

本流程明确复用现有 Computer 级信任边界：同一 Computer 上带 proof 的可见 Session 共享私有 Slack 管理目录及保留的原生登录，因此这些 Agent 可管理该 Slack CLI 授权所能访问的所有 App。Account 操作码只控制 OpenTag 的创建和绑定，不能把原生管理授权限制到一个 App，也不提供同 Computer 内的 Agent 凭证隔离。应仅在该 Computer 运行可信 Agent；不新增 Agent 级 Slack 授权或凭证隔离机制。

## 安装同一个 App 并捕获凭证

在私有 `project-<intent>/` 目录准备几份小文件：

- `.slack/config.json`：`{"manifest":{"source":"remote"}}`。
- `.slack/hooks.json`：`{"hooks":{"get-hooks":"node hooks.mjs"}}`。
- `manifest.json`：上一步无回调的原 Manifest。
- `manifest.mjs`：`import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));`。
- `hooks.mjs`：把下列对象输出为 JSON；deploy 中使用当前环境的 CLI 名称。

```json
{
  "runtime": "node",
  "hooks": {
    "get-manifest": "node manifest.mjs",
    "deploy": "opentag slack capture-deploy --create-response-file project-<intent>/create-response.json --output-file project-<intent>/credentials.json"
  }
}
```

运行 `opentag slack manage --project-dir project-<intent> -- app link --team <team-id> --app <app-id> --environment deployed`，再运行 `opentag slack manage --project-dir project-<intent> -- platform deploy --team <team-id> --app <app-id>`。Deploy 已包含安装，不额外执行 install，也不用 force 覆盖远端 Manifest。官方 hook 提供 `SLACK_BOT_TOKEN`；捕获命令用 `auth.test` 核对 Bot，向 0600 私有文件写入 App ID、Team ID、Bot User ID、Bot Token 和 Signing Secret，stdout 只有完成提示。原生配置/输出目录为 0700。

需要管理员审批时，在此暂停。管理员在自己的 Slack 设备批准后恢复同一个 App 的安装，不在凭证就绪前索取 Account 操作码。

## 一次确认和绑定

把 creationIntentId、name、displayName、来源 Agent 的 runtimeProvider 和可选的 model、reasoningEffort、instructions 写入 `agent.json`。组合入口严格拒绝 computerId、runtimeConfig.permissions 和 runtimeConfig.maxDurationMs，Server 固定使用 Session proof 验证的当前 Computer，并要求 Provider 与来源 Agent 相同，避免从需审批的 Provider 切换到 Pi 的全权限策略。权限和时长使用现有默认值；owner 后续可在普通 Account 入口修改：

```sh
opentag agent provision-slack --request-file <agent.json> --credentials-file <private-credentials.json> --json
```

没有 `--code-file` 时只校验本地输入，返回确认链接和拟创建的 Agent/App/Team，不请求 Server。Account owner 用自己的设备打开链接，点击“生成并复制操作码”，然后粘贴回原 Agent 对话。剪贴板不可用时保留可选择复制的码，不再申请第二个码。将码保存为私有文件，用同一命令增加 `--code-file <private-code-file>` 提交。把成功的 `--json` 标准输出保存到私有管理目录内 `project-<intent>/provision-result.json`，用于回调配置。

提交只发送一次 `POST /api/v1/runtime/agent/slack-provision`。Server 验证 Session proof，解析原 Agent 的 Account，消费匹配的操作码，调用现有创建服务，再只绑定该创建结果。保留 Computer 所有权、Slack App/Team/Bot 和 scope 校验、绑定冲突和凭证加密存储。self-configuration 开关语义不变，不接受任意目标 Agent ID 或 Account ID。

现有鉴权签发入口 `POST /api/v1/me/connect-codes` 只增加固定用途 `slack-agent-provision`，默认请求/响应保留普通登录行为。操作码格式为 `slack-provision.<随机部分>`，完整码哈希后，在哈希结果外再加固定用途前缀，写入现有 tokenHash 字段。旧 Server 只计算普通 hex 哈希，因此回滚后也无法兑换这种操作码。普通 Token 兑换在消费前拒绝该前缀，组合入口拒绝普通登录码；去掉或替换前缀无法命中原哈希。不增加 purpose 列或中间换票请求。

## 回调和失败恢复

绑定后 export 同一个 App 的远端 Manifest，再由 CLI 本地生成回调更新：

```sh
opentag slack manage --project-dir project-<intent> --team <team-id> --output-file project-<intent>/remote.json -- api apps.manifest.export --json '{"app_id":"<app-id>"}'
opentag slack callbacks --manifest-file project-<intent>/remote.json --provision-result-file project-<intent>/provision-result.json --output-file project-<intent>/callback-update.json
```

`slack callbacks` 读取成功的 CLI 结果（`{"ok":true,"result":...}`）和导出的 Manifest，把 `apps.manifest.update` 请求写入 0600 私有文件。App ID 来自绑定，地址来自返回的 `slack.eventsUrl` / `interactionsUrl`，七项事件来自共享常量：`app_mention`、`app_uninstalled`、`message.channels`、`message.groups`、`message.im`、`message.mpim`、`tokens_revoked`。其他远端配置，包括事件与交互的附加设置，均保留。不要猜测事件或从 App 创建模板重建 Manifest。

把 `callback-update.json` 的**内容**作为原生 CLI `--json` 参数，先执行 `apps.manifest.validate`，再执行 `apps.manifest.update`；均用同一个 `slack manage --project-dir`、`--team`，各自指定私有响应 `--output-file`。文件已包含 `app_id` 和序列化的 `manifest`。重新 export 同一 App，核对回调及保留配置。本地生成不增加网络请求、确认、存储结构或流程记录。现有入站路由此时能找到 Signing Secret 并处理可能的 challenge。

返回实际 `slack.binding.identity.botUserId` 的提及和 App/Team 私信链接；有 `slack.binding.bot.displayName` 时才显示实际名称。

- 创建结果不确定：核查已有 App，不自动重建。
- Schema、Provider 和码的有效性在消费前检查；创建与 Slack 身份验证在消费后执行，因此名称冲突或无效 Slack 凭证可能消耗码。这保证先完成一次性授权再执行副作用，不引入预留记录或额外换票；先核对本地准备文件。
- 码已消费或响应丢失：用新操作码、同一创建意图和配置恢复。保留未绑定 Agent；已有同 App/Team/Bot 绑定返回当前状态，不轮换凭证；不同绑定报冲突。
- 恢复时保持实际目标 Computer 和 Provider 不变。响应丢失后若原 Session 移动或 Provider 改变，现有创建指纹会安全地报冲突；应从原 Computer/Provider 恢复，不覆盖它们、不更换创建意图或静默创建另一个 Agent。
- 只更新回调失败：只恢复回调，不再次取码或绑定。
- Sandbox 重置/回收：管理登录和临时秘密可能丢失，重新授权并核查上下文 App ID，不承诺跨 Sandbox 无感恢复。
- 完成后删除本次临时秘密文件，保留仍有效的原生管理登录。

配置成功不等于真实收发已通过。Cloud 执行、管理员审批、实际异机操作和签名消息收发仍需另行授权的最小验收。

用途码入口在登录后可直接访问，即使 CLI 创建的 Account 尚未完成 Web 引导；其他页面仍保留原有引导门禁。
