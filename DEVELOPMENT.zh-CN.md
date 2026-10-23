# openTag 开发指南

> 权威来源：[DEVELOPMENT.md](./DEVELOPMENT.md)
> 同步日期：2026-10-21

## 从源码在本地运行

请准备 macOS 或 Linux、Node.js（使用 [.node-version](./.node-version) 中的版本）、pnpm 10.12.1、
支持 Compose 的 Docker，以及已登录的 Codex 或 Claude Code CLI。保持 Docker 运行，
并在已克隆仓库的根目录执行以下命令。

### 1. 安装 openTag

```bash
./scripts/dev-install.sh
```

此命令会安装依赖、构建应用，并将开发版 CLI 安装到 `~/.local/bin/opentag-dev`。

### 2. 保存本地配置

首次安装时运行一次以下命令，将配置和生成的密钥保存到 Git 忽略的 `.env.local` 中。
请保留此文件供以后重启使用；如果已有本地配置，请继续使用原有配置。

```bash
(umask 077; cat > .env.local <<EOF
OPENTAG_DATABASE_URL=postgresql://opentag:opentag@127.0.0.1:5432/opentag
OPENTAG_JWT_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
OPENTAG_ENV=dev
OPENTAG_HOST=127.0.0.1
OPENTAG_PORT=8000
OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
OPENTAG_DEV_AUTH_BYPASS_ENABLED=true
OPENTAG_DEV_AUTH_EMAIL=admin@example.com
EOF
)
```

### 3. 启动服务器

加载配置、启动 PostgreSQL，并创建本地账号：

```bash
set -a
source .env.local
set +a
docker compose up -d --wait postgres
pnpm --filter @opentag/server bootstrap:admin
pnpm --filter @opentag/server start
```

保持此终端运行。创建账号只需执行一次；以后启动请按照[停止与重启](#停止与重启)操作。

### 4. 连接 Agent

打开 <http://127.0.0.1:8000>，选择**开发者登录**。进入 **Agents**，按照设置步骤选择 Codex 或
Claude Code，然后在第二个终端中运行页面生成的连接命令。

按照聊天设置流程连接 Slack 或飞书，然后给 Agent 发消息。
Slack 的额外设置步骤见[配置指南](./docs/system/messaging/slack-app-setup.md)。

## 管理员操作

有两个命令直接操作数据库，不经过服务器。两者都需要 `.env.local` 中的配置，以及最新的 `dist/`（`pnpm build`）：

- `pnpm --filter @opentag/server bootstrap:admin` 在空数据库上创建第一个账号。
- `pnpm --filter @opentag/server transfer:agent` 把一个已有 Agent 转移到另一个账号。

### 把 Agent 转移到另一个账号

```bash
set -a
source .env.local
set +a
OPENTAG_TRANSFER_AGENT_ID=<agent-uuid> \
OPENTAG_TRANSFER_TARGET_ACCOUNT_ID=<account-uuid> \
OPENTAG_TRANSFER_SLACK=disable \
  pnpm --filter @opentag/server transfer:agent
```

Agent 必须处于暂停（suspended）状态。命令在单个事务内完成，以 JSON 输出结果，同时向 stderr 写一条脱敏的审计日志。
前置条件不满足时命令以非零状态退出，并在该日志行里写明原因：Agent 未暂停、目标账号下已有同名 Agent、或者仍有 Turn 可能落到
旧的 Computer 上。解绑消息连接不会清除 Turn 检查：那条未完成的 Delivery 仍留在数据库中，因此在它被处理完之前，命令会持续拒绝。

请在 Computer 在线时暂停 Agent：本命令没有 Runtime 连接，依赖暂停步骤已经停止 Session 并让旧 Computer 的 placement 退役。
那次停止是尽力而为的，暂停时离线的 Computer 不会被本命令重试。

只按 Agent 归属的数据会一起转移：Skills、instructions 与历史。Computer 会被解绑，因此在新账号绑定自己的 Computer 之前，
该 Agent 不显示 Computer。MCP 挂载及其保存的凭据会被删除，因为它们指向的 Server 定义属于原账号。

Schedules 保留为记录但被暂停（`enabled = false`，没有下次触发时间），结果中会报告暂停了多少条。每条 Schedule 都绑定一个
目标会话，而该会话随转移结束，因此它无法继续投递。新账号需要从自己拥有的会话重新创建 Schedule。

按 Agent 归属的使用历史（token 数量与结果，不含消息内容）跟 Agent 走，因此新账号的用量视图会包含原账号执行过的 Turn。
账单历史本身不会被改动。

`OPENTAG_TRANSFER_SLACK` 决定消息绑定的处理方式：

- `disable`（默认）禁用绑定，并释放不再使用的 Slack installation。
- `keep` 保留 Slack 绑定及其 installation，在新账号下继续为该 Agent 提供服务。飞书绑定无法保留，会以
  `im_binding_keep_unsupported` 拒绝。

## 停止与重启

在服务器终端中按 Ctrl+C 停止服务器。再次启动时，在仓库根目录运行：

```bash
set -a
source .env.local
set +a
docker compose up -d --wait postgres
pnpm --filter @opentag/server start
```

每次打开新的服务器终端都需要加载配置。使用现有数据库时，请继续使用已保存的密钥。
服务器启动时会自动执行数据库迁移。

Agent 作为独立的后台服务运行。使用以下命令停止或启动它：

```bash
~/.local/bin/opentag-dev daemon stop
~/.local/bin/opentag-dev daemon start
```

运行 `docker compose stop postgres` 可停止 PostgreSQL，数据会保留在 Docker 数据卷中。

## 修改代码

修改代码后，停止服务器，重新构建，并在已加载配置的终端中启动：

```bash
pnpm build
pnpm --filter @opentag/server start
```

修改 CLI 或 Agent 运行时代码后，还需运行 `~/.local/bin/opentag-dev daemon restart`。
依赖发生变化后，请先运行 `pnpm install` 再构建。

| 目录 | 内容 |
| --- | --- |
| `apps/web` | Web 界面 |
| `apps/cli` | 命令行界面 |
| `packages/server` | API、身份认证和数据库 |
| `packages/client` | 服务器客户端和本地 Agent 运行时 |
| `packages/shared` | 共用 schema 和类型 |

界面翻译请参阅 [Web 国际化](./docs/system/web/i18n.md)。

## 检查

数据库及读写改动先遵循[数据库读写规范](./docs/system/database-read-write-standards.md)。
在变更方案和评审中说明适用的规范编号、例外及验证范围。

### 本地验证

根据变更行为及其使用方选择检查范围。开发过程中与创建 pull request 前使用同一套标准；无需仅为创建 PR
而重复运行未变更代码上已经通过的检查。每次 commit 前运行 `pnpm check`。完整回归矩阵由 CI 执行，合并前必须通过。

| 改动 | 本地验证 |
| --- | --- |
| 仅文档 | `pnpm check`；无需应用构建或测试。同步根目录的中文镜像。作为运行时输入发布的 Markdown（如内置 Skills）应按受影响 package 的范围验证。 |
| 单个 package 内的行为 | 相关测试文件与该 package 的类型检查。影响遍及 package 或范围不明确时，扩展到整个 package 的测试套件。 |
| 共用 schema、公共导出或跨 package 契约 | 提供方测试，以及受影响使用方的测试与类型检查。测试使用方前先构建变更的导出。 |
| 数据库查询、事务、锁或持久化 | 相关服务器单元测试与 PostgreSQL 集成测试。新增 migration 必须运行完整集成套件，并按 `AGENTS.md` 更新 migration 计数。 |
| `vitest.agent-runtime.config.ts` 覆盖的 Agent Runtime 实现或测试，或该配置本身 | 先运行针对性测试，再运行 `pnpm --filter @opentag/client test:agent-runtime:coverage`。100% 覆盖率门禁以 CI 的 Ubuntu 主机为准；报告平台相关失败。 |
| 仓库脚本或 workflow | 相关 `scripts/__tests__/*.test.mjs` 文件，以及改动涉及的构建或打包冒烟检查。 |
| 构建、导出、生成代码或打包 | 受影响的构建，以及相关测试与类型检查。 |
| 依赖、工具链或共用测试/构建配置 | 扩展到受影响的 package 及其使用方；影响涉及整个仓库或无法界定时，运行 `pnpm build`、`pnpm typecheck` 和 `pnpm test`。 |
| 根目录覆盖率配置或全仓库覆盖率排查 | `pnpm test:coverage`。常规改动依靠 CI 的覆盖率检查。 |

渲染 UI 的改动还需执行相关浏览器验证，见 [E2E 指南](./e2e/README.md)。
在 PR 中记录执行的命令、所选范围为何覆盖改动，以及未执行或受阻的检查。只有后续编辑影响检查的输入或行为，
或新的失败、风险要求扩大验证范围时，才重新运行已通过的检查。筛选后没有匹配测试不算验证成功。

### 针对性命令

以下示例从仓库根目录运行，请按实际改动选择 package 与文件。测试通过构建后的导出导入工作区依赖。
直接运行 package 命令前先准备依赖，修改依赖源码后重新构建：

```bash
# 仅构建 client 的工作区依赖，然后运行一个测试文件。
pnpm exec turbo run build --filter='@opentag/client^...'
pnpm --filter @opentag/client test src/__tests__/auth.test.ts

# 运行整个 package 的测试与类型检查，由 Turbo 准备依赖。
pnpm exec turbo run test typecheck --filter=@opentag/web --concurrency=2

# 包含变更的 shared package 及依赖它的工作区。
pnpm exec turbo run test typecheck --filter='...@opentag/shared' --concurrency=2

# 运行一个仓库脚本测试。
node --test scripts/__tests__/git-hooks.test.mjs

# 准备 server 依赖并运行一个 PostgreSQL 集成测试文件（需要 Docker）。
pnpm exec turbo run build --filter='@opentag/server^...'
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/tasks.test.ts --maxWorkers=2
```

CLI 的 package 名称是 `open-tag`。运行针对性的 web 测试前，先用
`pnpm exec turbo run build --filter='@opentag/web^...'` 准备依赖，然后运行 `pnpm --filter @opentag/web test <test-file>`。
Vitest 的 Vite 插件会自动生成翻译。直接运行 web 类型检查前，先运行 `pnpm --filter @opentag/web paraglide`；
Turbo 的 web typecheck 任务已包含此步骤。文件路径相对于选定的 package。
文件筛选参数应直接传给 package 命令，不要转发到无关 package 的套件。

运行针对性的服务器集成测试时，使用上方直接调用 `exec vitest run` 的示例。向 `test:integration`
追加文件名仍会保留脚本已有的目录筛选条件，因而仍然选择整个集成套件。
需要完整集成套件时，运行 `pnpm --filter @opentag/server test:integration`。

每个 PostgreSQL 集成测试 fixture 启动独立的一次性数据库。本机 Docker 的随机映射端口只绑定
`127.0.0.1`；远程 Docker 保留默认绑定方式。启动后先从宿主机执行 `SELECT 1`，连接超时为五秒，
成功后才开始迁移或测试。若容器健康检查通过，但该查询失败，应检查 Docker 端口转发：TCP 端口开放
不代表 PostgreSQL 请求已到达容器。查询失败时，fixture 会关闭探测连接并删除容器。

### CI 与完整套件复现

CI 将格式检查、构建、类型检查、仓库脚本测试、PostgreSQL 集成测试和 Agent Runtime 覆盖率检查放在并行任务中执行。
工作区单元测试在 Node.js 22.22.2、24 和 26 上运行，每个版本使用三个 Vitest 分片。
仓库脚本测试也会在这三个版本上运行；兼容性任务在 Node.js 22.22.2 和 26 上验证打包后的 CLI，
`CLI Pack Smoke` 则覆盖 Node.js 24。汇总的 `CI` 检查要求所有任务和分片都成功。
Patch Coverage 在安装依赖之前先检查变更路径。现有可覆盖源码范围之外的变更会明确通过检查；
源码删除和重命名仍会触发覆盖率测量。源码变更由五个并行任务分别测量各工作区，并检查现有覆盖率下限。
最终任务要求所有报告齐全，拼接互不重叠的文件覆盖率数据，并执行不变的 80% 变更行覆盖率门槛。
缺失报告、测试失败或源码归属重叠都会使检查失败。每周的 Unit Coverage 工作流仍测量完整基线。

PR 的 Quality Scoreboard 在 CI 内运行，复用三个 Node 24 单元测试分片的耗时，不再重复运行测试。
耗时指标明确标为最慢工作区分片的耗时，不包含仓库脚本测试和 runner 排队时间；它与定时或手动运行时
测量的完整套件耗时不同。现有静态质量指标仍可用，汇总的 `CI` 状态要求 PR 的质量报告成功。

本地 `pnpm test` 仍以有限并发运行完整测试套件。可使用以下命令在本地重现一个工作区单元测试分片：

```bash
pnpm build
pnpm exec turbo run test --concurrency=2 -- --shard=1/3
```

## Git hooks 与 worktree

`pnpm install` 会安装 Git hook，在提交前格式化并检查暂存文件，在推送前检查仓库。
pre-push hook 执行仓库 lint、format、`pnpm check` 与 `pnpm typecheck`；两个 hook 都不运行测试。
这些 hook 检查在上方的针对性测试之外执行。
新建 Git worktree 时会自动安装依赖。如果 worktree 尚未初始化，请在其中运行 `pnpm worktree:setup`。
分支和 pull request 约定见[贡献指南](./CONTRIBUTING.zh-CN.md)。

## 排查问题

- **本地登录失败：** 确认服务器已加载 `.env.local`，且已创建初始账号。
  开发者登录要求 `OPENTAG_ENV=dev`，主机地址和公开 URL 均为回环地址。
- **提示“Bootstrap has already been completed”：** 数据库已有账号，请使用上方的重启命令。
- **Agent 无法连接：** 运行 `~/.local/bin/opentag-dev doctor` 和 `~/.local/bin/opentag-dev daemon status`。
- **查看后台服务日志：** Linux 上运行 `journalctl --user -u opentag-dev.service`；macOS 上查看 `~/.opentag-dev/logs`。

本地 Agent 配置和文件默认保存在 `~/.opentag-dev` 中。请备份此目录以保留本地工作和会话状态；
服务器无法恢复这些文件。

## 配置与参考资料

更多配置见 [.env.example](./.env.example)。将需要的配置添加到 `.env.local`，重新加载后再重启服务器。

如需在本地使用 Google 登录，请创建 Google Web OAuth 客户端，将回调 URL 设为
`http://127.0.0.1:8000/api/v1/auth/callback/google`，并在本地配置中设置 `OPENTAG_GOOGLE_CLIENT_ID`
和 `OPENTAG_GOOGLE_CLIENT_SECRET`。

- [部署指南](./docs/operations/deploying.md) — 部署配置与运维。
- [Runtime 协议](./docs/system/runtime/runtime-protocol.md) — 服务器与 Agent 的通信。
- [Provider CLI](./docs/system/messaging/direct-provider-cli.md) — Codex 和 Claude Code 集成。
- [可观测性](./docs/operations/observability.md) — 服务器追踪与诊断。
- [发布指南](./docs/operations/releasing.md) — 通过 GitHub Actions 发布。
