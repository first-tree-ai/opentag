# Provider CLI 管理基础架构

[English](../../design/provider-cli-management.md)

状态：提案

最后更新：2026-08-30

## 1. 目的

本文定义 OpenTag Agent 使用官方飞书/Lark 与 Slack CLI 所需的最小本地架构，覆盖安装范围、executable identity、异常状态、凭证交付和原生命令体验。

后续 landing、安装、独立修复与 doctor 产品必须复用本基础设施，不能另写 resolver、readiness 定义或 credential path。

## 2. 产品决策

1. **OpenTag-managed Provider CLI 默认安装为操作系统账户级全局命令。** 这里的全局表示不依赖 project、当前用户可以直接调用，不表示写入 root 管理的系统目录。
2. **安装后的命令就是 `lark-cli` 与 `slack`。** 人类 shell 与 Agent Runtime 使用同一命令。
3. **被执行的仍是官方 provider binary。** OpenTag 只管理安装、selection、薄 launcher 与临时凭证投影，不翻译 provider method，也不恢复 adapter send API。
4. **安装默认确定性且无交互。** OpenTag CLI 检测用户当前环境中已经可见的 compatible command，自动选择最新兼容版本，并在内部持久化其路径；没有 compatible local command 时立即执行 managed install。用户不输入 absolute path，OpenTag 也不修改 selected external installation。
5. **Detection 与 runtime authority 分离。** 用户侧 detection 只对 invoking CLI process PATH 中的 exact command name 做一次有界扫描。daemon 后续只使用 selected candidate 持久化的 canonical path，不启动 login shell，也不扫描 version manager 或 well-known directory。
6. **Readiness 由 daemon 只读作答。** 调用方 shell 的 `HOME`、`XDG_CONFIG_HOME`、PATH 与 provider login state 都不能改变结论。
7. **Provider credential 只属于 Turn。** Installation、version、login、subscription 和 API-token usability 是相互独立的事实。
8. **只有 exact、compatible 且 probe 成功的 executable 才是 ready。** Unknown、stale、ambiguous 或 partial installation 一律 fail closed。

Direct-provider-CLI 边界不变：OpenTag 负责入站事实、路由与凭证投影；Agent 使用官方 `lark-cli` 或 `slack api` 发送；provider-native outbound truth 留在 OpenTag 外部。

## 3. 最小架构

```text
reviewed ProviderCliCatalog
          |
          v
显式 ProviderCliInstaller mutation
          |
          v
账户级 global store + 稳定 lark-cli/slack launcher
          |
          +-------------------------> human shell
          |
          v
daemon ProviderCliManager --probe--> fresh local readiness --> Server
          |
          v
Turn exact-target plan + private credential environment
          |
          v
Agent Runtime: lark-cli ... / slack api ...
```

只保留五个组件：

| 组件 | 职责 |
| --- | --- |
| `ProviderCliCatalog` | 经过 review 的版本、平台 asset、digest、license 与 probe contract。 |
| `ProviderCliInstaller` | 显式 managed install、upgrade、rollback 与 remove。 |
| Account-global launcher | 以原生命令名执行 selected official binary。 |
| `ProviderCliManager` | 只读 selection validation、probe、readiness 与 exact Turn plan。 |
| `CredentialEnvironmentManager` | Authorized private Turn environment 与 cleanup。 |

Server 只接收 provider、粗粒度 readiness、freshness 与 connection identity，不接收 local path、selection record、package manifest 或 credential-file path。

## 4. 账户级全局布局

Global root 从 installed service 的操作系统 account record 得出，不使用调用方环境变量或 `OPENTAG_HOME`：

```text
POSIX:   <account-home>/.opentag/provider-cli/
Windows: <account-local-app-data>/OpenTag/provider-cli/  # reserved, not P0

provider-cli/
  bin/lark-cli       # OpenTag Runtime authoritative launcher
  bin/slack[.exe]    # OpenTag Runtime authoritative launcher
  versions/<provider>/<version>/<platform>-<arch>/<sha256>/...
  state/<provider>.json
  staging/<provider>/<operation-id>/...
  plans/<turn-id>/...
```

`provider-cli/bin` 是 OpenTag Runtime 的唯一权威 command directory。默认情况下，installer 还会在当前 portable installer 已使用的 `<account-home>/.local/bin` 创建 OpenTag-owned public shim；因此用户可以直接运行原生命令，而 daemon 与 Agent Runtime 始终 prepend `provider-cli/bin` 的 absolute path，不依赖 shell startup file。portable installer 使用自定义 `BIN_DIR` 时，由安装流程把这个已解析目录传给 Provider CLI manager，不把它暴露成 external-path 登记功能。

如果 public command name 已被 unmanaged file 占用，OpenTag 不覆盖它。内部 Runtime launcher 仍可精确执行 selected target，但 install result 必须报告 `global_command_shadowed`，并明确说明人类 shell 当前实际会运行哪一份。这个 warning 不伪装成 Runtime installation failure；只有内部 launcher 或 selected target 不可用时 readiness 才失败。

产品不写 `/usr/local/bin`、`/usr/bin`、其他 package manager prefix 或 root-owned directory，也不需要 `sudo`。如果用户 shell 已优先解析到同名的其他命令，activation 报告 `global_command_shadowed`，不覆盖原文件。执行 install flow 本身即授权幂等复用 OpenTag launcher 已使用的 account-global PATH registration，不再二次 prompt；`--no-path-update` 可以退出该操作，但结果在用户自行修复 PATH 前不会标记 globally active。

同一个操作系统账户下的所有 OpenTag Home 共享这套全局 Provider CLI。每个 daemon 独立 probe 当前唯一 selection；旧 OpenTag version 不兼容时报告 `version_incompatible`，不能静默选择或安装另一版本。

## 5. Selection model

只存在两种 selection：

```ts
type ProviderCliSelection =
  | { kind: "managed"; artifactId: string }
  | {
      kind: "external";
      executablePath: string;
      fingerprint: string;
      trust: "catalog-verified" | "compatible-unverified";
    };
```

External selection 只能从用户侧 detector 返回的 candidate 创建。Path resolution 由 detector 完成；用户或 Agent 会收到 resolved path 作为反馈，但不需要输入、编辑或确认。没有 eligible external candidate 时，同一次 operation 直接执行 managed install。

### 5.1 External detection contract

Detection 是只读 OpenTag CLI operation，不是 daemon readiness。它：

1. 读取 invoking CLI process 的 PATH，并在 Windows 读取 `PATHEXT`；
2. 只检查 absolute PATH directory 中的 exact provider command name；
3. 忽略 empty、relative、current-directory、protected-root 与 unsafe world-writable entry；
4. 按 realpath canonicalize 并 deduplicate candidate；
5. 在无 credential、无 provider API request 的条件下校验 regular-file、executable、platform、architecture、version 与 required command surface；
6. 即使 current selected target 不在 caller PATH 也将其纳入候选，并把 OpenTag account-global launcher 识别为 managed candidate，不作为 external candidate 展示；
7. 返回 ephemeral candidate ID、canonical path、version、source directory、fingerprint 与 trust level。

Digest 匹配 shipped catalog 时标记 `catalog-verified`。其他 compatible artifact 标记 `compatible-unverified`：OpenTag 不能证明其 provenance，因此结果必须明确披露；但用户或 Agent 显式执行安装脚本本身即授权使用检测到的本地命令。要求只使用 catalog-verified managed artifact 时可传 `--managed-only`，完全跳过 external selection。

Validation 后按固定规则选择 candidate：

1. 丢弃 unsafe、version 无法解析、unsupported 与 incompatible candidate；
2. 按 normalized semantic version 降序，最新版本优先；
3. 同版本优先 `catalog-verified`，再选 `compatible-unverified`；
4. version 与 trust 都相同时，选择 invoking shell PATH 实际最先解析的 command；
5. 报告所有 ignored candidate 及原因，并报告 selected path、version、trust 与 tie-breaker。

Candidate set 包含 current managed/external selection 与新检测到的 PATH candidate，因此重复 `ensure` 仍会发现更高版本，不会提前返回。

持久化前，CLI 通过 canonical path 重新打开 winner，并复核 candidate ID 与 fingerprint。Candidate 已变化时将其剔除，再次执行 ranking；最终没有 eligible candidate 就执行 managed install。流程不会停下来要求用户选择。

Candidate ID 只存在于该次 CLI operation 的内存中。后续或独立 invocation 必须重新 detection，不保存 durable pre-selection candidate cache。

External target 必须是 protected root 外的 regular executable file，且不能解析回 OpenTag launcher。系统记录并重新校验 canonical realpath、platform、architecture、version 与 file identity。OpenTag 不升级、不删除、不移动、不登录、不修复 external artifact。

自动选择的 `compatible-unverified` external installation 仍是必须明确披露的 install-script trust decision；diagnostics 必须如实标记 provenance，不能标记为 `opentag-verified`。

Installation 完成后，Runtime 不再有 automatic precedence chain 或 ambiguity：

- selected target 健康就使用；
- selected target 不健康就是 unavailable；
- 只有显式 `ensure` 或 install operation 可以切换 target；daemon readiness 永远不切换。

账户级 global launcher 与 persisted selection 逐字节 reconcile，并透明执行该 exact selected official binary。Inspection 遇到 launcher missing、replaced 或 mismatch 时 fail closed，下一次显式 `ensure` 负责修复。它原样转交 argv、stdin、stdout、stderr、signal 与 exit status，不解释 provider operation。PR 2 再加入 per-Turn plan，使 active Turn execution 不受并发 selection update 影响。

在 OpenTag Turn 之外，launcher 就是普通 global provider command，使用用户自己的 provider environment。因此用户可以直接使用 OpenTag-managed CLI。Managed target 永远不 self-update；launcher 关闭 update check，只通过 `ProviderCliInstaller` 升级。External target 在 OpenTag Turn mode 外继续采用 operator-owned update behavior。

## 6. Managed installation transaction

Catalog entry 只含经过 review 的静态数据：

- provider 与 native command name；
- exact supported version 或 compatibility range；
- platform、architecture、archive type 与预期 executable；
- 官方 artifact URL 与 SHA-256 digest；
- bounded download、archive 与 executable size；
- 非敏感 probe command 与 timeout；
- license 与要求的 third-party notice。

daemon 不读取可变 remote `latest` manifest；Catalog 只能随经过 review 的 OpenTag release 更新。

初始 probe contract：

| Provider | Command | 必需 local probe |
| --- | --- | --- |
| 飞书/Lark | `lark-cli` | `--version`、`im --help` |
| Slack | `slack` | `version`、`api --help` |

Probe 使用新建的 private temporary HOME/config directory，移除 caller credential variables，并关闭 update check；bounded probe 完成后删除该目录。它不访问用户正常 provider 配置、不携带 Integration credential，也不请求 provider API。

一次显式 install/upgrade 是一个 transaction：

1. 获取 account/provider exclusive lock；
2. 下载到唯一 private staging directory，并设置 time/size limit；
3. 校验 exact digest，只安全解压预期 file；
4. 拒绝 path traversal、absolute archive member、device、setuid/setgid file、unexpected link 或 executable；
5. 发布到 digest-addressed immutable version directory；
6. 执行完整 non-secret compatibility probe；复用已经 publish 的 digest-addressed directory 时也必须重新 probe；
7. reconcile internal launcher 与 OpenTag-owned public shim；不覆盖 unmanaged command，PATH shadowing 作为 local warning 报告，但不降低 internal Runtime readiness；
8. 原子替换 selection record；
9. 刷新 readiness，并保留 previous version 用于 rollback。

第 8 步前失败不会改变 persisted selection record。Crash 或写入失败导致 launcher/selection mismatch 时，inspection fail closed，下一次显式 `ensure` 修复。Startup recovery 只清理当前 provider lock 对应 staging subtree 内可识别的 stale directory，不能删除另一 provider 的并发操作。Previous version 只有在未被选择、没有 Turn plan 引用且 retention grace period 已结束时才能删除。

OpenTag 不在 daemon readiness 中运行 upstream global installer 或 arbitrary npm `postinstall`，而是从 catalog 安装经过 review 的 official release artifact。这样 Lark 与 Slack 虽然上游 packaging 不同，仍使用同一 lifecycle。

第 7 步校验当前 installer environment 与 installer 自己维护的 account-global PATH registration。它属于 install activation，不是从任意 future caller shell 推断 daemon readiness。如果用户之后改变 PATH，daemon 仍从 absolute global bin 得出 readiness；未来 installer 或 doctor 可以另行报告 user-command shadowing。

## 7. Probe 与实际执行必须同源

当前实现可能 probe 一个 absolute path，随后要求 Agent 从 PATH 运行另一个 bare command。Global launcher 用来消除这个 gap。

`ProviderCliManager` 校验 selected target，并通过 global launcher 执行 probe，随后记录 selection generation、canonical target、file identity、version，以及 managed digest 组成的 fingerprint。

Visible Turn admission 前，manager：

1. 校验 current fingerprint；
2. 在 fixed runtime plan root 下写入一个固定 exact target 与 fingerprint 的 `0600` private、non-secret plan record；
3. 将 plan ID 写入 Turn environment。

Launcher 只接受 bounded plan ID，在 fixed private plan root 下解析它，并校验 file ownership 与 shape；OpenTag Turn mode 执行 pinned target，而不是当前 account-global selection。因此 managed update 可以原子切换 global selection，但不会改变 active Turn。旧 immutable target 会保留到引用它的所有 plan 被删除。External executable 被替换后返回 `artifact_drifted` 并重新 probe，不能 fallback 到另一项 PATH entry。

Human invocation 不需要 Turn plan。Atomic selection 与 immutable version path 允许已运行进程正常结束，后续命令使用新版本。

## 8. 凭证交付

Authorized visible Turn 的流程：

```text
fresh ready selection
  -> private exact-target Turn plan
  -> Server fenced credential grant
  -> private provider config + 0600 environment file
  -> Agent source OPENTAG_PROVIDER_ENV_FILE
  -> Agent 执行 lark-cli ... 或 slack api ...
  -> Turn 结束：删除 credential/config/plan
```

Environment file 包含 non-secret Turn plan ID、OpenTag Turn-mode marker，以及当前 provider 必需变量：

- **飞书/Lark：** 私有 `LARKSUITE_CLI_CONFIG_DIR`、bound App identity/brand、fresh tenant access token，并排除 user access token；
- **Slack：** `SLACK_BOT_TOKEN`，显式移除 `SLACK_USER_TOKEN` 与 `SLACK_APP_TOKEN`，并提供 private config directory。Turn mode 中由 launcher 加入 Slack global `--config-dir`、关闭 update check，再转发 Agent 的 native arguments。

Turn mode 之外，launcher 不应用 OpenTag credential 或 private config，因此用户可以正常配置和使用全局安装的 CLI。

Credential 不进入 selection record、process argv、prompt、log、persistent Runtime binding 或 Server readiness。Internal Session 永远不取得该文件。Cleanup 在 Turn completion 执行，在 Session/Client shutdown 重试，并在 crash 后由下次 Client startup 恢复。Plan file 不含 credential，但使用相同的有界 cleanup lifecycle。

本设计不要求 `lark-cli auth login`、`slack login`、provider subscription check 或 static API-token check；OpenTag authorized Bot grant 是该 Turn 的 credential authority。

## 9. 最小状态与诊断

```ts
type ProviderCliLocalState =
  | "checking"
  | "absent"
  | "ready"
  | "unavailable";
```

稳定 diagnostic code 保留原因，但不扩张 state machine：

| Code | 含义 |
| --- | --- |
| `not_installed` | 没有 managed artifact 或 external selection。 |
| `global_bin_unavailable` | Account-global command directory 无法创建或使用。 |
| `launcher_invalid` | OpenTag-owned global launcher missing、replaced 或 malformed。 |
| `global_command_shadowed` | 用户 shell 优先解析到其他 command。 |
| `external_path_invalid` | Selected external path missing、unsafe、non-regular 或 non-executable。 |
| `external_not_detected` | Invoking CLI 没有发现 compatible existing command。 |
| `external_candidate_changed` | Candidate identity 在 selection 前或后续 validation 中变化。 |
| `external_candidate_unverified` | Candidate compatible，但 digest 不在 reviewed catalog。 |
| `artifact_drifted` | Selected target 在 validation 后改变。 |
| `integrity_failed` | Managed digest、manifest 或 archive 无效。 |
| `version_incompatible` | Version 或要求的 native command surface 不受支持。 |
| `probe_failed` | 有界 version/help probe 失败或 timeout。 |
| `install_incomplete` | 显式 mutation 在 publish 前失败。 |
| `credential_unavailable` | Installation ready，但当前 Turn 无法取得或 materialize credential。 |

只有 `ready` 映射为 Server `ready`；`absent` 映射为 `install`；error-severity failure 映射为 `unavailable`；观察进行中映射为 `checking`。`global_command_shadowed` 与 `external_candidate_unverified` 是必须展示的 local warning，不单独降低 Runtime readiness。Credential error 让 Turn 失败，但不修改 installation readiness。

Path 与 diagnostic detail 留在本地；raw child-process output 与 secret 不进入 Server 或日志。

## 10. 对抗性检查后的保留方案

| 攻击或故障 | 必须行为 |
| --- | --- |
| Doctor shell 改变 HOME、XDG 或 PATH | Daemon selection/readiness 不变。 |
| Project 在 PATH 放入假 `lark-cli`/`slack` | Runtime prepend absolute global bin，不选假命令。 |
| Detection PATH 包含 `.`、relative 或 world-writable directory | Detector 忽略 unsafe entry，不展示其中 command。 |
| Detection 后 candidate 被替换 | 剔除该 candidate，重新排序其余候选；最终没有候选则 managed install。 |
| PATH 中存在多份 compatible command | 最新 compatible semantic version 优先；trust 与 effective PATH order 是固定 tie-breaker。 |
| Process 提供 forged plan path | Launcher 只接受 private fixed plan root 下的 bounded ID，并校验 plan record。 |
| Package manager 中存在多个版本 | 不扫描，只考虑 explicit selected target。 |
| External binary 在 probe 后被替换 | Fingerprint 校验失败并返回 `artifact_drifted`。 |
| Update 与 active Turn 竞争 | Turn plan 继续执行 pinned immutable target；新 selection 只影响后续 Turn。 |
| Download 截断或 archive 恶意 | Digest 与 safe extraction 在 publish 前失败。 |
| Install 过程中 crash | Active selection 不变；启动时恢复 recognized staging。 |
| 环境中已有 Slack/Lark login | Turn private config 与 explicit Bot variable 胜出，不使用 user credential。 |
| 用户直接运行 managed CLI | 使用普通 user config 正常执行，不获得 OpenTag secret。 |
| 已有 unmanaged 同名命令 | 不覆盖、不弹 prompt；报告 shadowing 与实际解析目标，OpenTag Runtime 继续使用内部 launcher。 |
| 同账户存在多个 OpenTag Home | 共享 account-global selection；各 daemon 独立 probe，不兼容 daemon fail closed。 |
| Global install 需要 root | 以 user-level remediation 失败，OpenTag 不提权。 |

以下旧想法因为不必要的复杂度被明确排除：

- 把两个 provider binary 打入基础 npm 包；
- daemon runtime 调用 upstream global install script；
- 递归扫描 home；
- 启动 login shell 发现 PATH；
- 枚举 nvm/fnm/asdf/mise/package-manager version；
- 维护 per-Turn command directory；
- 向 Server 上报 local executable path；
- 把 login、subscription 或 API-token usability 当作 installation readiness。

## 11. 后续产品功能使用的基础接口

```ts
inspect(provider): ProviderCliDiagnostic;       // read-only
detectExternal(provider, callerEnvironment):
  readonly ProviderCliCandidate[];              // read-only, user CLI scope
ensure(provider, mode = "auto"):
  ProviderCliEnsureResult;                      // select newest or managed install
install(provider, catalogArtifact): void;       // explicit mutation
useManaged(provider): void;                     // explicit mutation
removeManaged(provider, version): void;         // explicit mutation
planForTurn(provider): ProviderCliTurnPlan;     // ephemeral local state
```

后续 landing/download、install-script、standalone 与 Agent-driven flow 都调用 `ensure`。执行安装 flow 本身就是 selection 或 managed installation 的显式授权，不再二次确认。`auto` 自动选择 newest eligible local version，没有时 managed install；`managed-only` 跳过 local candidate。流程不能复制 secret、接管 external package，也不能隐藏 candidate 胜出的原因。

### 11.1 Agent-friendly execution 与信息反馈

Install flow 必须在没有 TTY 时工作，并且不产生 prompt。Human mode 使用有界单行 phase update，不使用 spinner：

```text
[lark] detect: 2 candidates
[lark] select: 1.0.92 external /canonical/path (newest compatible)
[lark] verify: ready
```

必需 phase 为 `detect`、`select` 或 `managed-install`、`verify`、`ready` 或 `failed`。反馈包括 provider、action（`noop`、`selected-existing` 或 `installed-managed`）、version、canonical path、source、trust、ignored candidate 与原因，以及 final readiness；不包含 credential 或 raw untrusted child-process output。

Agent 和 automation 使用 `--json`：stdout 只输出一个稳定 JSON document，包含同样的 phase record 与 final result，不输出 ANSI、spinner 或 prompt；该模式抑制 human progress。Exit code：ready（含 idempotent no-op）为 `0`，operational failure 为 `1`，invalid usage 为 `2`。`--dry-run` 只做 detection、ranking 与 reporting，不进行 selection 或 install。

JSON result 的最小结构：

```ts
interface ProviderCliEnsureResult {
  ok: boolean;
  provider: "feishu" | "slack";
  action: "noop" | "selected-existing" | "installed-managed" | "failed";
  phases: Array<{ phase: string; status: "started" | "completed" | "failed" }>;
  selected?: { path: string; version: string; source: string; trust: string };
  candidates: Array<{
    path: string;
    version?: string;
    trust?: string;
    disposition: "selected" | "ignored";
    reason: string;
  }>;
  readiness: "ready" | "unavailable";
  globalCommand: { active: boolean; path?: string; resolvedPath?: string };
  warnings: Array<{ code: string; remediation?: string }>;
  diagnostic?: { code: string; remediation?: string };
}
```

多 provider execution 为每个 provider 返回一份 result；任一 requested provider 失败时 overall exit code 非零，已成功 provider 不 rollback。

重复执行必须 idempotent：只有 current healthy selection 仍是全部 compatible installed candidate 中排名最高的一份时才报告 `noop`；发现更高 local version 时自动选择并报告。没有 eligible external candidate 时，较旧的 OpenTag-managed selection 升级到当前 reviewed catalog artifact；较旧 OpenTag binary 不能降级一份更高且 incompatible 的 managed selection。Managed install 中断不改变 prior selection，下次执行从 detection 安全继续。使用 `ensure --dry-run` 可在不修改 selection 的情况下 detection/ranking caller PATH 中的安装；`inspect` 只校验 persisted account selection，不从 caller PATH 推断 selection。

未来 doctor 可以展示同一份 diagnostics，但不能从自己的 PATH 推断 daemon readiness，也不能把 version probe 解释成 authentication 或端到端可用。现有 P0 `opentag doctor` 范围保持不变，直到产品规格被显式修改。

## 12. 当前实现对比

当前 `origin/main` 已具备 direct-provider-CLI 的后半段，但还没有第三方 CLI package manager。应保留与替换的边界如下：

| 能力 | 当前实现 | 与本规格的差距 | 落地动作 |
| --- | --- | --- | --- |
| IM CLI readiness wire | `computer.ts` 只有 `checking/install/ready/unavailable`；Client heartbeat 上报，Server 带 freshness 保存并用于 handoff gate。 | 粗粒度模型已经足够；本地原因无法表达。 | **保留 wire 与 Server 逻辑。** 本地 manager 映射到现有四态，不上报 path/version。 |
| Command discovery | `refreshImCliReadiness` 只从 daemon PATH 解析第一份 `lark-cli`/`slack`。 | 没有多候选、版本排序、trust、selection 或 account authority。 | 用 `ProviderCliManager.inspect()` 替换 resolver；daemon 不做 external detection。 |
| Probe | 已有 Lark `--version` + `im --help`、Slack `version` + `api --help`，10 秒 timeout。 | error 全部折叠，version 未解析，也没有 executable identity。 | 把现有 probe contract 移入 catalog，增加 bounded output、diagnostic 与 fingerprint。 |
| Selection/storage | 不存在；`larkCliCommand`/`slackCliCommand` 只用于测试注入。 | probe 与后续 Agent bare command 可能不是同一文件。 | 新增 account-global selection record、generation 与 immutable managed artifact。 |
| Credential handoff | `ImCredentialEnvironmentManager` 已写入 `0600` Turn env；Lark 使用 private config，Slack 注入 Bot token 并排除 user/app token；已有 cleanup/recovery。 | 未绑定 Provider CLI target；Slack private config 需要按 official CLI contract 补齐。 | **扩展现有 manager，不新建第二套 secret store。** env 只增加 plan ID/Turn marker。 |
| Agent command | Prompt 已要求 source env file 后运行原生 `lark-cli`/`slack api`。 | Runtime PATH 未 prepend authoritative launcher，存在 probe/execution 分叉。 | 保留 prompt，在 Session workspace environment prepend account-global launcher，并在 Turn env 绑定 plan ID。 |
| Install/upgrade | 无 Provider CLI command；portable installer 只安装 OpenTag 自身。 | 无 catalog、digest、transaction、global activation 或 Agent-friendly output。 | 新增 `opentag provider-cli ensure/inspect`；portable `.sh` 后续只调用该命令，不复制 package logic。 |
| 安装事务基础 | portable installer 已有 pinned manifest、SHA-256、immutable version、pre-commit smoke、atomic `current` 与 stable shim。 | 逻辑在 shell 中，不能直接作为 Provider CLI manager 使用。 | 复用它的事务语义与测试模型；Provider CLI transaction 在 TypeScript 中实现。 |
| OS account authority | daemon service 已从 `userInfo().homedir` 解析 account home，不依赖 caller `HOME`。 | `packages/client` 只有基于 `OPENTAG_HOME`/`homedir()` 的 Home layout。 | 新增可注入 `accountHome` 的 account-global layout；CLI 与 daemon 都传 OS account record。 |
| Doctor | P0 doctor 按既有规格不检查 Integration CLI。 | 本功能不能借机扩 doctor。 | **本轮不改。** 后续 doctor 只消费 manager diagnostics，不能从 doctor shell PATH 推断 daemon。 |
| Login/token/subscription | 当前 readiness 不验证这些事实。 | 无；这是已明确的产品边界。 | **本轮不做，也不据此宣称端到端 ready。** |

因此最小代码路径是：保留 `RuntimeImCliReadinessObservation`、Server registry、handoff gate、credential grant 与 outbox prompt；只替换 Client 本地 command resolution，并在其前面补齐可复用的 package-management core。

### 12.1 当前实现中必须先消除的 false green

当前 daemon 可以 probe PATH 中解析到的 absolute executable，Agent 随后却在另一个 shell 中执行 bare command。两边 PATH 不同时，Server 可能收到 `ready`，但 Agent 实际执行另一份文件或得到 command not found。

首个 Runtime integration 的验收条件不是“probe 通过”，而是同一测试中证明：

```text
selected target fingerprint
  == daemon probed target fingerprint
  == Turn plan target fingerprint
  == Agent native command actual executable fingerprint
```

## 13. 落地方案

### 13.1 模块边界

新增实现放在 `packages/client/src/runtime/provider-cli/`，而 Commander 输出留在 `apps/cli`：

```text
packages/client/src/runtime/provider-cli/
  account-layout.ts       OS account-global paths; no OPENTAG_HOME authority
  catalog.ts              reviewed artifacts, compatibility and probe contract
  detector.ts             caller-PATH exact-name detection and fingerprinting
  selection-store.ts      schema-v1 state, atomic write and generation
  installer.ts            lock, download, digest, safe extract and publish
  launcher.ts             global shim reconciliation and exact exec plan
  manager.ts              inspect, ensure, readiness mapping and planForTurn

apps/cli/src/core/provider-cli/
  ensure.ts               reusable command orchestration
  inspect.ts              read-only diagnostics

apps/cli/src/commands/provider-cli.ts
                          thin Commander and human/JSON rendering
```

`packages/client` 使用已有 secure durable-file primitives；需要的 account/provider lock 也在该 package 内实现，不能反向依赖 `apps/cli` 的 daemon lease。Semantic version 使用显式 direct dependency，不能依赖 pnpm transitively hoisted package，也不能手写不完整 prerelease ordering。

P0 支持范围与当前 daemon service 一致，仅为 macOS 与 Linux。Windows layout 与 launcher contract 可以保留在 schema 设计中，但在真实 daemon/Agent QA 前不得宣称支持。

### 13.2 两个 PR

#### PR 1：Provider CLI 管理基础能力

目标是交付一套可以独立使用和验收的第三方 CLI manager，不改变 daemon、handoff、Agent Turn 或安装页面的现有行为。

PR 内可以拆成多个可编译 commit：

1. account-global layout、reviewed catalog、PATH detector、version/fingerprint 与 newest-wins ranking；
2. selection store、exclusive lock、bounded download、digest/safe extraction、immutable publish 与 launcher；
3. `opentag provider-cli inspect` 和完整 `opentag provider-cli ensure`，以及 deterministic tests 和本地 E2E。

PR 1 合入后，用户或 Agent 可以独立运行：

```sh
opentag provider-cli inspect --provider lark|slack|all [--json]
opentag provider-cli ensure --provider lark|slack|all \
  [--managed-only] [--no-path-update] [--dry-run] [--json]
```

`ensure` 必须一次完成最终语义：发现多份时选择最新 compatible version；没有 eligible candidate 时立即 managed install；成功后 human shell 可以运行原生 command。不能留下“下一 PR 才支持 managed install”的临时状态。

PR 1 的验收闭环：

- fresh account root 下覆盖零/一/多份 external、unsafe path、版本排序、candidate replacement 与 idempotent rerun；
- local HTTP fixture 覆盖正确包、错误 digest、截断、恶意 archive、错误 architecture、probe failure 与中断恢复；
- publish 前失败保持旧 selection 不变；non-TTY 无 prompt；JSON stdout 只有一个 document；
- 不改变 `refreshImCliReadiness`、Server wire、Turn credential 或 portable installer。

Rollback 只移除显式 Provider CLI management command；现有 Runtime 完全不依赖 PR 1 的 state 或 launcher。

#### PR 2：OpenTag 产品接入

目标是让 PR 1 的基础能力进入正式 onboarding、daemon readiness 与 Agent 执行链路。

PR 内可以拆成多个可编译 commit：

1. daemon readiness 与 Visible Turn exact execution 的原子切换及测试；
2. portable installer、onboarding/download provider option 与无交互反馈；
3. Docker/macOS、official binary 与 staging credential 的产品 E2E 和 QA 记录。

Runtime 接入必须一次完成：daemon probe selected target、Turn plan pin 相同 fingerprint、Agent Runtime prepend authoritative launcher，并让 Agent 的 bare `lark-cli`/`slack api` 实际执行同一 target。不能先切 readiness、后补 Agent PATH。

安装流程只调用已合入的 `opentag provider-cli ensure`，不能在 `.sh` 或 Web 中复制 detector、ranking、catalog 或 download logic。Provider CLI 安装失败时保留已经成功安装的 OpenTag base，返回非零并输出 remediation。

PR 2 的验收闭环：

- 两个同名、不同 fingerprint 的 fixture CLI 分别污染 daemon PATH 与 Agent PATH，最终 selection、probe、Turn plan 和实际执行必须一致；
- 覆盖 managed update/active Turn race、external drift、caller HOME/XDG/PATH 变化、ambient credential 排除与 cleanup recovery；
- fresh Docker Linux 与 macOS 使用同一 scenario contract 验证 external、managed fallback、多版本、shadowing、重复安装与失败恢复；
- macOS/Linux 各运行 pinned official binary 的 native help/version；使用 staging credential 各完成一次真实 daemon-to-Agent `lark-cli` 与 `slack api` execution。

Rollback 恢复 legacy Runtime resolver 和原 portable install flow；Server 不需要 schema rollback 或数据迁移。

### 13.3 提交与验收规则

- 两个 PR 串行：PR 2 只建立在已合入并验收的 PR 1 head 上，不维护并行 stacked PR；
- 每个 commit 必须可编译，并通过 `pnpm check`、`pnpm typecheck` 与影响范围的 targeted test；implementation 与对应 failure-path test 同 commit；
- 每个 PR head 必须从 fresh worktree 和空临时 account root 通过 `pnpm check`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm test:coverage` 与 `git diff --check`；
- merge-blocking tests 使用本地 fixture 和 local HTTP server，不访问可变 upstream；真实 binary/daemon/staging credential 属于额外产品 QA gate；
- PR description 记录 exact base/head、运行命令、fixture digest、支持/未验证平台与 rollback 边界；head 变化后全部重新执行。

### 13.4 明确不在本轮落地

- 不修改 Server URL、registration protocol 或 readiness schema；
- 不在 doctor 中加入 Provider CLI、login、subscription、API-token 或端到端发送检查；
- 不恢复 Lark/Slack outbound adapter；
- 不扫描 package-manager internals、home tree 或 login shell；
- 不自动覆盖 unmanaged global command，不提权；
- 不在 OpenTag npm 包内直接捆绑两份 Provider CLI binary。

两个 PR 必须按 PR 1 → PR 2 验收。PR 1 只交付可独立使用的基础能力；只有 PR 2 通过 exact-executable 与安装 E2E 后，daemon 和 onboarding 才切换到新 manager。任何阶段失败都可以在不改 Server state 的情况下回退。

## 14. 上游依据

- [Lark CLI releases](https://github.com/larksuite/cli/releases)
- [Lark CLI configuration source](https://github.com/larksuite/cli/blob/main/internal/core/config.go)
- [Slack CLI installation](https://docs.slack.dev/tools/slack-cli/guides/installing-the-slack-cli-for-mac-and-linux/)
- [`slack api` token resolution and flags](https://docs.slack.dev/tools/slack-cli/reference/commands/slack_api/)
