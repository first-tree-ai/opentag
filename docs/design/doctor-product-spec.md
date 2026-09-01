# Doctor 产品需求与 P0 技术规格

状态：已实施（P0 基线及 Provider CLI 静态扩展）

最后更新：2026-09-01

## 1. 文档目的

本文档定义：

1. 通用 CLI `doctor` 命令应承担的基础职责；
2. OpenTag 应当参考或避免照搬 First Tree `doctor` 的哪些设计；
3. `opentag doctor` 的最小 P0 产品与技术契约。

P0 的核心决策是：

> `opentag doctor` 诊断当前 CLI 调用所选 OpenTag Home 的基础状态。它不证明
> Daemon、Provider、Integration 或端到端 handoff 已经就绪。

这一区分是规范性要求。P0 成功只表示本文定义的所有 blocking 检查均已通过。
输出不得将其表述为“OpenTag 已就绪”“handoff 已就绪”或“所有必要检查均已通过”。

## 2. 通用 CLI Doctor 契约

### 2.1 产品职责

CLI doctor 是只读的诊断编排器。它应当按顺序回答五个问题：

1. **正在诊断哪个目标？**
2. **实际检查了哪些前置层？**
3. **哪些检查通过、失败、无法判断或被明确排除？**
4. **每个失败最窄、最可能的原因是什么？**
5. **操作员下一步可以安全地做什么？**

Doctor 不是通用状态页，也不是修复命令。相关命令应保持以下边界：

| 命令类型 | 职责 | 是否允许修改状态 |
| --- | --- | --- |
| `status` | 快速展示单个子系统的当前状态 | 否 |
| `doctor` | 对多个前置层执行有界、只读的关联诊断 | 否 |
| `probe` 或 `test` | 执行显式选择、可能更深或带副作用的检查 | 仅在自身契约明确允许时 |
| `repair`、`install`、`login`、`connect` | 修改本地或远端状态 | 是，但必须由操作员明确发起 |

### 2.2 基础能力

无论产品的具体检查项如何，生产级 doctor 都应具备以下能力：

| 能力 | 要求 |
| --- | --- |
| 明确诊断目标 | 解析并打印被检查的精确 profile、home、cluster、project 或其他作用域。不得静默混合多个权威来源。 |
| 分层检查 | 区分本地配置、本地依赖、服务/进程状态、网络可达性、认证和端到端行为。不得用低层检查推断高层结论。 |
| 类型化结果 | 至少支持 `pass`、`fail`、`unknown`、`info` 和 `skipped`。不得把 `unknown` 或 `skipped` 显示成通过。 |
| Blocking 策略 | 根据明确的产品承诺标记 blocking 与 non-blocking，不能把所有结果行等同处理。 |
| 依赖处理 | 前置条件无效时跳过依赖检查，同时继续执行相互独立的检查，并说明跳过原因。 |
| 可执行诊断 | 给出有界的原因、可安全执行的修复建议或文档入口，但不直接执行修复。 |
| 有界执行 | 为网络请求和子进程设置超时。任何一个依赖都不能无限阻塞命令。 |
| 安全性 | 保持只读、无交互提示、无模型/API 消耗，且绝不输出秘密或不受信任的原始响应正文。 |
| 自动化能力 | 返回可靠的退出码，并将展示层与结构化结果模型分离。 |
| 诚实总结 | 明确说明通过的是哪一级能力，并列出重要但未检查的部分。 |

### 2.3 结果语义

最小内部结果模型如下：

```ts
type DoctorCheckStatus = "pass" | "fail" | "unknown" | "info" | "skipped";

type DoctorCheckScope =
  | "target"
  | "local-configuration"
  | "daemon-service"
  | "server"
  | "agent-runtime"
  | "provider-cli";

interface DoctorCheck {
  code: string;
  scope: DoctorCheckScope;
  status: DoctorCheckStatus;
  blocking: boolean;
  label: string;
  detail: string;
  observedFrom?: string;
  path?: string;
  remediation?: string;
}

interface DoctorReport {
  target: {
    home: string;
    homeSource: "environment" | "channel-default";
  };
  checks: DoctorCheck[];
  exitCode: 0 | 1;
}
```

只有所有 blocking 检查均为 `pass` 时，进程才返回 `0`。任意 blocking 检查为
`fail` 或 `unknown` 时返回 `1`。`info` 和 `skipped` 本身不影响退出码。无效命令
语法仍由 CLI 框架作为 usage error 处理，不属于 doctor 的诊断结果。

即使发现问题并返回 `1`，人类可读的完整报告仍输出到 stdout；意外的命令级错误
可以额外输出到 stderr。P0 不要求公开 `--json` 参数，但展示层必须消费结构化结果，
以便未来增加稳定 JSON 接口时不需要重写检查逻辑。

## 3. First Tree 参考分析

### 3.1 证据基线

本分析基于 First Tree `main`：
[`2851a9e021bbb3cc9579d165f04825f767ebb8fc`](https://github.com/first-tree-ai/first-tree/tree/2851a9e021bbb3cc9579d165f04825f767ebb8fc)，
以及 OpenTag `main`：
[`0e8410e68f53fe1e369e12c17617e1e6a370ee05`](https://github.com/first-tree-ai/opentag/tree/0e8410e68f53fe1e369e12c17617e1e6a370ee05)。

First Tree 顶层 `doctor` 与 `daemon doctor` 当前共用同一个检查编排器，已实现的检查包括：

- Node.js 版本；
- Client 配置；
- 带五秒超时的 Server `/healthz` 可达性；
- 本地 Agent 配置，以及条件允许时与 Server 的登记状态核对；
- 一条名为 WebSocket 的检查；
- 后台服务状态；
- 权威 Daemon owner 状态；
- Local Context 完整性；
- install-only 的 Runtime Provider 能力检测，包括 `lark-cli`。

相关源码：

- [`apps/cli/src/commands/_shared/doctor-checks.ts`](https://github.com/first-tree-ai/first-tree/blob/2851a9e021bbb3cc9579d165f04825f767ebb8fc/apps/cli/src/commands/_shared/doctor-checks.ts)
- [`apps/cli/src/core/doctor.ts`](https://github.com/first-tree-ai/first-tree/blob/2851a9e021bbb3cc9579d165f04825f767ebb8fc/apps/cli/src/core/doctor.ts)
- [`packages/client/src/providers/capabilities/detect.ts`](https://github.com/first-tree-ai/first-tree/blob/2851a9e021bbb3cc9579d165f04825f767ebb8fc/packages/client/src/providers/capabilities/detect.ts)
- [`packages/client/src/runtime/install-locations.ts`](https://github.com/first-tree-ai/first-tree/blob/2851a9e021bbb3cc9579d165f04825f767ebb8fc/packages/client/src/runtime/install-locations.ts)
- [`packages/client/src/runtime/protected-paths.ts`](https://github.com/first-tree-ai/first-tree/blob/2851a9e021bbb3cc9579d165f04825f767ebb8fc/packages/client/src/runtime/protected-paths.ts)

### 3.2 OpenTag 应当参考的设计

1. **复用生产检测逻辑。** Runtime 安装检查应使用 Runtime 自己的 Provider
   capability probe，不能重新实现另一套“已安装”定义。
2. **将安装与认证分开。** First Tree 当前的 capability 契约只回答是否存在可启动的
   artifact。它不启动 Provider、不执行 `--version`、不读取凭据，也不发起模型请求。
3. **报告 artifact 来源。** Capability 数据区分 bundled 和外部路径来源，并能携带
   实际解析到的路径。
4. **不要只搜索调用方 PATH。** 受控的安装位置清单覆盖常见 native installer、
   package manager 和 version manager 路径；macOS App bundle 单独处理。
5. **保护自动文件系统发现。** 自动探测不得进入 macOS TCC 保护的 Desktop、
   Documents、Downloads、iCloud Drive 或云盘目录，包括通过符号链接间接进入。
6. **限制远端检查时间。** Server 可达性检查有固定 deadline。
7. **只诊断，不修复。** Doctor 只输出修复建议；安装、登录、清理和服务修改必须由
   显式命令完成。

### 3.3 OpenTag 不应照搬的设计

First Tree 是有价值的实现参考，但不是 OpenTag 的产品契约。以下行为不应原样复制：

1. **只有布尔结果不够。** First Tree 的 `CheckResult` 只有 `ok: boolean`，无法区分
   blocking 失败、可选 Provider 缺失、无法判断的探测以及因依赖而跳过的检查。
2. **汇总结论过宽。** `All checks passed` 没有说明它代表本地安装、Daemon 可用、
   已认证还是端到端交付。
3. **WebSocket 检查并没有建立 WebSocket。** 它重复执行 HTTP health 请求并格式化
   一个 `ws:` URL。Doctor 不得把 HTTP 可达性标记为 WebSocket 已验证。
4. **检查失败不会驱动命令退出码。** Renderer 会打印问题数量，但命令没有根据这些
   结果设置非零退出码。
5. **观察权威不明确。** Runtime discovery 运行在 doctor 进程中，却与 Daemon service
   状态一起展示。调用方 `PATH` 的观察不能被表述成已安装 Daemon 可解析该 artifact
   的证明。
6. **所有 Provider 缺失被当成同一种问题。** 产品必须明确一个 Runtime 是否足够，
   并把缺少的可选 Provider 单独展示。

## 4. OpenTag P0 产品规格

### 4.1 用户与使用场景

P0 面向已经安装 OpenTag CLI、需要判断当前 OpenTag Home 为什么无法完成基础本地职责
的操作员。

命令为：

```console
opentag doctor
```

P0 不接受 doctor 专属的目标参数。它没有 `--server-url` 或 `--server`，并忽略
`OPENTAG_SERVER_URL`。Server 是 Computer credential 的属性，不是诊断命令的调用方输入。

`OPENTAG_HOME` 仍然有效，因为它是选择一套完整本地 OpenTag 安装的既有全局入口。
没有设置时，使用当前 channel 的默认 Home。报告始终打印解析后的绝对 Home 路径及其来源。

### 4.2 P0 产品承诺

P0 只回答以下问题：

1. 当前 OpenTag Home 的本地 Computer identity 与 Computer credential 是否结构有效、内部一致？
2. 同一 Home 的 Daemon service 是否 active，并且在既有 service-status 边界内保持一致？
3. 该 Home 记录的唯一 Server 是否通过公开 health endpoint 正常响应？
4. 当前 CLI 诊断上下文能否找到至少一个受支持的本地 Agent Runtime CLI artifact，
   每个 artifact 从哪里找到？
5. 当前操作系统账户下的 Feishu/Lark 与 Slack Provider CLI 是否已经存在有效的
   account-global selection？

第四项明确属于 **CLI 上下文中的安装观察**。它不能证明已安装 Daemon 拥有相同环境，
也不能证明 Daemon 能执行该 artifact。输出必须明确说明这一点。

P0 决策如下：

| 决策 | P0 契约 | 理由 |
| --- | --- | --- |
| 诊断目标 | 当前 OpenTag Home | Home 是 OpenTag 完整本地安装的边界。 |
| Server 来源 | 仅使用 Home 内经过验证的 Computer credential | 调用方指定 URL 会诊断一个 Computer 可能永远不会使用的 Server。 |
| Daemon service | 检查状态及 Home 一致性 | 停止或绑定错误的服务属于基础本地故障，即使 P0 不承诺端到端就绪。 |
| Runtime 安装 | Codex 与 Claude Code，只做 install-only 检查 | Artifact 缺失可以在不调用 Provider、不读取凭据的前提下安全诊断。 |
| Runtime 充分条件 | 至少安装一个受支持 Runtime | P0 没有权威的 Agent-to-Provider 分配视图；缺少其他 Provider 仍需展示，但不 blocking。 |
| Runtime 观察权威 | 当前 CLI 上下文，并明确披露 | 准确判断已安装 Daemon 的 Provider 解析能力需要单独评审权威契约。 |
| Runtime 认证 | 不检查 | 凭据存在、Provider 登录状态与可用的已认证执行是不同产品承诺。 |
| Integration CLI | 只读报告 Feishu/Lark 与 Slack 的 account-global 安装选择，均为 non-blocking | Doctor 可以帮助定位第三方 CLI 安装状态，但不能从静态检查推断 active binding、凭证或真实 handoff readiness。 |
| 自动修复 | 禁止 | 诊断必须保持安全、可重复和只读。 |

### 4.3 P0 Blocking 检查

#### A. 目标 Home

报告必须展示：

- OpenTag Home 的规范化绝对路径；
- 路径来自 `OPENTAG_HOME` 还是 channel 默认值；
- CLI 版本、channel、platform、architecture 和 Node.js 版本，作为信息性诊断上下文。

解析路径不得创建 Home 或任何缺失目录。

#### B. 本地 Computer 配置

本地配置属于 blocking 检查。Doctor 必须只读检查文件，不得调用可能创建或重写
identity 状态的 helper。

只有全部满足以下条件时，检查才通过：

- Home/config 路径符合现有 private-storage 安全读取规则；
- `computer.json` 存在且有效；
- `computer-credentials.json` 存在，使用受支持的 envelope version，并包含唯一一个
  可用 Computer credential；
- Doctor 结果中不存在被静默丢弃的格式错误 Computer credential；
- Computer credential identifier 符合 credential format 的唯一性规则；
- 该 Computer credential 的 `computerId` 与 `computer.json` 相同；
- 该 Computer credential 包含规范的唯一 Server origin；
- identity 的 `serverUrl` 与该规范 Server origin 完全一致。

Doctor 绝不能打印 `machineToken`、credential 文件内容，或可能包含文件数据的未脱敏
解析错误。

#### C. Daemon service 基线

Daemon service status 属于 P0 blocking 检查，并且必须复用现有只读 Daemon service
manager/status 实现。

只有全部满足以下条件时，检查才通过：

- 当前 platform 受支持；
- service 已安装且为 active；
- service 的 configured Home 可验证为当前 OpenTag Home；
- service definition 不存在 drift；
- 既有 runtime-owner consistency 结果与 active service 一致。

Inactive、not-installed、unsupported、drifted、Home 不匹配、malformed、unverified 或其他
unknown 状态都必须 fail closed。报告应包含既有 log hint；在可以安全给出时，提供最窄
修复命令。

Service-status 边界必须从经过评审的绝对位置执行受治理的系统程序，包括 NixOS systemd
路径等受支持的非 FHS 位置。通过调用进程 `PATH` 解析裸的 `launchctl`、`systemctl` 或
`loginctl` 不具备权威性，不能产生 P0 pass。Issue
[#244](https://github.com/first-tree-ai/opentag/issues/244) 可以在独立的 service-module
变更中实现，但它的正确性条件是 `daemon.service` 检查能够通过的前置条件。

Issue [#239](https://github.com/first-tree-ai/opentag/issues/239) 的 service-module 约束为：
service manager 必须从同一次操作系统 account record 快照取得 uid、username 与 account
home；launchd plist 与 systemd user unit 均从该 account home 下的产品约定位置查找。调用
CLI 的 shell 所提供的 `HOME` 或 `XDG_CONFIG_HOME` 不得改变 service definition 的位置。
这与 First Tree 中“连接流程安装 daemon、doctor/status 复用同一 supervisor backend”的
产品行为一致，但 OpenTag 不复用其受 shell home/XDG 影响的路径解析实现。

OpenTag 当前不支持把 service definition 安装到自定义 XDG 路径。如果操作系统的用户级
service manager 被配置为只从其他位置加载 unit，安装/状态后置条件必须失败，不得猜测
另一份 definition 或转成 pass。

#### D. 已登记 Server 的健康状态

Server URL 只能来自经过验证的本地 Computer credential。Server health 检查必须：

- 对该 origin 执行 `GET /healthz`；
- 设置五秒 deadline；
- 使用 `ServerHealthSchema` 验证响应；
- 区分配置错误、timeout/network failure、非 2xx HTTP 和响应结构无效，同时不暴露原始
  response body。

该检查只证明公开 health endpoint 可达并返回预期 schema。它不证明 machine token
有效、不证明 WebSocket registration 可用，也不证明 Server 可以交付 Turn。

如果本地配置无效，Server 检查应为 `skipped`，原因为“没有权威的绑定 Server”；
Daemon service 与 Runtime artifact 等独立检查仍需继续运行。

#### E. Agent Runtime CLI artifact

P0 分别报告 Codex CLI 与 Claude Code CLI。只要至少一个受支持 Runtime artifact 被确定为
已安装，blocking 汇总检查就通过。缺少另一个 Provider 只属于信息性结果，不 blocking。

P0 中“已安装”的定义是：

> 共享的生产 resolver 在不启动 Provider 的前提下，为该 Provider 选中了一个普通、
> 可执行的文件。

Resolver 必须由生产 Client Runtime 与 doctor 共用，避免两套解析逻辑漂移。它必须：

- 只有在 OpenTag 真正提供显式路径配置时才接受该配置；P0 不得发明 doctor 专属的
  Provider override；
- 搜索诊断进程的 `PATH`；
- 搜索经过评审的 well-known 安装目录；
- 仅为 Codex 搜索经过验证的 macOS ChatGPT/Codex App bundle 位置；
- 不得把具有执行位的目录、broken link、不可执行文件或不安全的自动候选项当成已安装；
- 在 `stat`、`access`、`realpath`、目录枚举或其他会跟随路径的读取之前，应用相同的
  macOS protected-root 策略；
- 返回选中的规范路径及来源：`caller-path`、`well-known`、`desktop-app`，或未来真实
  存在的配置来源；
- 每个 Provider 独立失败，单个 detector 错误不能隐藏另一个 Provider 的结果。

P0 不得启动 `codex` 或 `claude`，不得请求 `--version`/`--help`，不得检查认证、初始化
app server、发起模型请求、安装 binary 或修改 Provider 配置。

`CLAUDE_CONFIG_DIR` 具有 credential 语义，不是安装信号。Artifact discovery 不得合成或
注入它：未设置时保持未设置；显式值只作为已标记的观察上下文保留。Client Runtime 在
[#236](https://github.com/first-tree-ai/opentag/issues/236) 中的缺陷属于独立 Runtime
正确性修复，不能成为 doctor 声称已检查 Claude Code 认证的理由。

#### F. IM Provider CLI 静态安装状态

Doctor 分别报告 Feishu/Lark CLI 与 Slack CLI 的 account-global selection。两项均为
non-blocking：尚未绑定对应 IM provider 的账户不需要预先安装；active binding 对应的
强制 readiness 由 Server 与 daemon 的 binding-driven reconcile 负责，不由 Doctor 推断。

静态检查必须复用 `ProviderCliManager.inspect`，并遵守以下边界：

- account home 只来自操作系统账户记录，不受调用方 `HOME`、`XDG_*` 或 `OPENTAG_HOME`
  影响；调用方 `PATH` 只用于展示 global command shadowing，不决定已持久化 selection；
- 允许执行既有 selection 的 bounded、无凭证 version/help probe；
- 不得调用 `ensure`、下载或安装 artifact、创建/修复 launcher/shim、写入 selection；
- 不得读取或投影 binding credential，不得调用 provider auth/message API；
- `ready` 只表示本地 selection、fingerprint、launcher 与无凭证 probe 一致；不得表述为
  credential、active binding 或 handoff ready；
- 缺失 selection 显示为信息项；malformed、unsafe 或无法判断的状态保持可见，但不改变
  P0 baseline 退出码。

### 4.4 必需输出

人类可读报告采用固定 section 顺序，避免并发检查改变输出顺序：

1. Target
2. Local configuration
3. Daemon service
4. Server
5. Agent Runtime CLIs
6. IM Provider CLIs
7. Summary
8. Not evaluated

示例结构如下。实际 CLI 文案保持英语：

```text
OpenTag Doctor

Target
  - OpenTag Home: /Users/alice/.opentag (channel default)
  - CLI: 0.x.y, stable, darwin arm64, Node.js v24.x

Checks
  ✓ Local Computer configuration: 1 credential, one Computer, one Server
  ✓ Daemon service: active for this OpenTag Home
  ✓ Server health endpoint: reachable at https://example.opentag.dev
  ✓ Agent Runtime CLI: at least one supported Runtime is installed
  ✓ Codex CLI: installed at /Applications/ChatGPT.app/.../codex (desktop-app)
  - Claude Code CLI: not installed

IM Provider CLIs
  ✓ Lark CLI: managed 1.0.92 selected at /Users/alice/.opentag/provider-cli/...
  - Slack CLI: not prepared for this account

Baseline checks passed for this OpenTag Home.

Not evaluated
  - Agent Runtime authentication
  - Agent Runtime version or protocol compatibility
  - Agent Runtime visibility from the installed daemon environment
  - machine-token authentication or WebSocket registration
  - Integration CLI credential validity and active-binding readiness
  - end-to-end Turn or handoff delivery
```

Summary 只能是以下两种之一：

- `Baseline checks passed for this OpenTag Home.`
- `N blocking baseline check(s) failed for this OpenTag Home.`

报告必须始终包含上述 `Not evaluated` section。只有在对应能力拥有经过评审的契约，并且
确实执行了该检查之后，未来版本才能移除某一项。

### 4.5 修复建议策略

Doctor 只打印指导，不执行任何修改。修复建议必须遵守以下规则：

- 只有全部必需的非秘密参数已知时，才打印可直接执行的完整命令；
- 否则说明应采取的操作，并指向相关命令或文档；
- 不得嵌入 connect code、token、credential 文件内容或直接复制的原始 Provider 错误；
- 不得代替操作员执行删除、重写、重新连接、重新安装、重启或登录；
- 未检查 Runtime 认证时，不得建议用户登录 Runtime。

## 5. P0 技术架构

### 5.1 所有权与依赖方向

Commander 注册层保持轻量。`apps/cli` 负责编排与展示；可复用的本地存储检查、Server
health 和 Runtime artifact inspection 通过 `@opentag/client` 的公共接口提供。

```text
apps/cli command
  -> apps/cli doctor orchestrator
       -> client local Computer inspector
       -> existing CLI daemon service manager.status()
       -> client Server health checker
       -> client shared Runtime artifact resolver
       -> client ProviderCliManager.inspect()
  -> apps/cli renderer
```

Doctor 可以并发协调检查，但依赖关系必须显式：

- 先解析 target，再运行任何检查；
- local configuration 与 Runtime artifact 检查可以相互独立地启动；
- Daemon service status 不依赖 Server health；
- Provider CLI 静态检查使用 account-global state，与 OpenTag Home 和 Server health 独立；
- 只有解析出唯一权威 Server 后才启动 Server health；
- renderer 等待所有独立检查结束，并按固定 section 顺序输出。

### 5.2 必需实现边界

1. **Doctor 不得复用 `resolveComputerIdentity`。** 它可能创建或重写 identity 状态；
   Doctor 需要严格只读的 inspector。
2. **不得把 credential projection 当作完整 doctor 结论。** Runtime reader 只需要投影当前绑定，
   但 doctor 必须报告 envelope 或 Computer credential 的任何损坏，不能把无效配置报告为健康。
3. **不得在 CLI 中重复实现 Runtime resolution。** 应提取或扩展生产 resolver，随后由
   Runtime composition 与 doctor 共用。
4. **不得把 `/healthz` 转换成 readiness 结论。** Result code 和 label 必须只描述公开
   Server health。
5. **不得把 exception 折叠成“未安装”。** 必须区分明确缺失与 detector 无法判断。
6. **不得让并发完成顺序决定报告顺序。** 先汇总结构化结果，再统一渲染。

### 5.3 稳定检查代码

P0 check code 属于内部契约，也是未来 JSON 接口的基础：

| Code | Blocking | 含义 |
| --- | --- | --- |
| `target.home` | 否 | 选中的规范 OpenTag Home 及来源 |
| `local.identity` | 是 | `computer.json` 存在、安全且有效 |
| `local.credentials` | 是 | credential envelope 及唯一的 Computer credential 均有效 |
| `local.binding` | 是 | Computer identity、Computer credential 和唯一 Server origin 一致 |
| `daemon.service` | 是 | 已安装 service active、配置未漂移并属于当前 Home |
| `server.health` | 是 | bound Server 的公开 `/healthz` 在 deadline 内通过 |
| `runtime.any-installed` | 是 | 至少找到一个受支持 Runtime artifact |
| `runtime.codex.installation` | 否 | Codex artifact 观察结果 |
| `runtime.claude-code.installation` | 否 | Claude Code artifact 观察结果 |
| `provider-cli.feishu.installation` | 否 | Feishu/Lark account-global selection 观察结果 |
| `provider-cli.slack.installation` | 否 | Slack account-global selection 观察结果 |

### 5.4 性能与安全预算

- Agent Runtime 检查不启动 Provider 子进程；Provider CLI 静态检查只允许 bounded、无凭证
  version/help probe，不发起认证、消息、模型或其他 provider API 请求。
- Server health deadline：5 秒。
- Service manager 子进程使用既有显式 deadline。
- 文件系统检查仅限当前 Home 和经过评审的安装根目录；不得递归扫描整个用户 Home。
- macOS 自动发现不得触发 TCC 授权提示。
- 在安全前提下并发执行独立检查；健康主机的预期总耗时低于 6 秒。
- 所有展示错误必须有长度上限并经过脱敏。

## 6. 验收标准

P0 至少需要使用确定性测试覆盖以下场景：

| 场景 | 必需结果 |
| --- | --- |
| 调用时提供 `--server-url` | CLI usage error；doctor 不接受该参数 |
| 环境中设置 `OPENTAG_SERVER_URL` | Doctor 的目标解析忽略该变量 |
| 环境中设置 `OPENTAG_HOME` | 打印规范 Home 以及 environment 来源 |
| 缺少 identity 或 Computer credential | 本地配置失败；Server skipped；独立检查继续运行 |
| 本地文件 malformed 或 unsafe | 本地配置失败，且不暴露文件内容 |
| credential envelope version 不受支持 | 本地 binding 失败；不联系 Server |
| Computer credential 的 Server URL 无效 | 本地 binding 失败；不联系 Server |
| Computer credential Computer ID 与 identity 不同 | 本地 binding 失败 |
| Service 对当前 Home 为 active | Daemon service 通过 |
| Service inactive、drifted、unknown 或属于其他 Home | Daemon service fail closed |
| 调用方 `PATH` shadow `launchctl`、`systemctl` 或 `loginctl` | 不执行 shadow；只有受支持的绝对 manager 才能提供状态 |
| `/healthz` timeout | Server health 在 deadline 内失败 |
| `/healthz` 返回非 2xx、无效 JSON 或无效 schema | 返回分类后的 Server failure |
| 名为 `codex` 的目录具有执行位 | 不得被识别为已安装 executable |
| 自动候选项穿过 macOS protected root 或符号链接 | 在跟随读取之前拒绝该候选项 |
| 只安装 Codex 或只安装 Claude Code | Runtime 汇总通过；缺少的另一个 Provider 为 info |
| 两个 Runtime 都未安装 | Runtime 汇总失败 |
| 一个 Provider detector 报错，另一个找到 artifact | 仍报告已找到的 Provider；detector error 为 `unknown` |
| Runtime 只从调用方 `PATH` 找到 | 来源标记为 `caller-path`；Daemon 可见性继续列为未检查 |
| Provider CLI selection 缺失 | 对应 provider 显示 info；不 blocking，也不安装 |
| Provider CLI selection ready | 显示 kind、version 与路径，但不声称凭证或 binding ready |
| Provider CLI state malformed、unsafe 或 inspector 失败 | 显示 fail/unknown；不修复、不隐藏、不改变 baseline 退出码 |
| Doctor 检查 Provider CLI | 不调用 `ensure`、不下载、不写 selection/launcher/shim、不调用 auth/message API |
| 任意报告包含 credential | 测试失败 |
| 所有 blocking P0 检查通过 | Exit `0`，并且只使用 baseline success 文案 |
| 任意 blocking 检查失败或 unknown | Exit `1`，不得使用 readiness 文案 |

## 7. 明确不属于 P0 的范围

以下能力推迟到各自产品契约完成评审后再实现：

- Agent Runtime authentication 或 credential presence
  ([#247](https://github.com/first-tree-ai/opentag/issues/247))；
- Agent Runtime version 与 protocol compatibility；
- 已安装 Daemon effective environment 内的权威 Provider resolution；
- Integration CLI credential validity、active-binding readiness 的 Doctor 检查，以及任何
  Doctor 主动安装/修复行为；
- machine-token validation、WebSocket registration 或端到端 Turn/handoff delivery；
- 自动安装、登录、重启、重新连接或修复；
- 对外公开的 JSON 输出及其兼容性保证；
- 超出现有已发布 platform contract 的 Windows Daemon service 支持。

这些未检查项不等于通过，并且必须持续显示在每次 P0 报告中。

## 8. 当前实现边界

OpenTag `main` 已实现本文 P0 基线。后续 Provider CLI 产品集成又增加了本规格 F 节定义的
non-blocking、只读 account-global installation 观察；它不改变 baseline 退出码，也不把
credential 或 active-binding readiness 纳入 Doctor。

PR [#246](https://github.com/first-tree-ai/opentag/pull/246) 在
`1f241dc42097471e2e194a4efbf8fba8098ba00e` 上已将 Server 选择改为本地 Computer credential，
并增加 install-only Runtime 观察，但不能按现状直接合并，原因包括：

- 将多个不同 enrolled Server 视为有效，但 Daemon 会拒绝这种配置；
- 未验证本地 Computer identity 与 enrollment binding；
- 缺少 Daemon service 基线检查；
- Server 请求没有 deadline；
- 可能把具有执行位的目录当成 Runtime artifact；
- 人类可读输出中没有展示 Runtime source；
- 没有披露 Runtime detection 使用调用进程上下文；
- 使用 `All required checks passed.` 作为汇总。

后续实现应以本文作为 Doctor source of truth，在合理情况下把共享 Runtime discovery 与 doctor
presentation 拆分，并继续将 authentication、active-binding readiness 与修复行为留在
binding-driven daemon 或各自 follow-up issue 中。
Runtime discovery issue
[#237](https://github.com/first-tree-ai/opentag/issues/237) 提供主要 artifact-resolution
实现范围。Service manager issue #244 继续保持独立代码变更，但必须在 P0 service 结果
能够被信任为 pass 之前落地。
