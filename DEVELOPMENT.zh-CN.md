# OpenTag 开发指南

> 权威来源：[DEVELOPMENT.md](./DEVELOPMENT.md)
> 同步日期：2026-09-28

## 从源码在本地运行

请准备 macOS 或 Linux、Node.js（使用 [.node-version](./.node-version) 中的版本）、pnpm 10.12.1、
支持 Compose 的 Docker，以及已登录的 Codex 或 Claude Code CLI。保持 Docker 运行，
并在已克隆仓库的根目录执行以下命令。

### 1. 安装 OpenTag

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
Slack 的额外设置步骤见[配置指南](./docs/zh-CN/slack-app-setup.md)。

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

界面翻译请参阅 [Web 国际化](./docs/zh-CN/i18n.md)。

## 检查

提交 pull request 前运行：

```bash
pnpm check
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/server test:integration
```

服务器集成测试需要 Docker。修改覆盖率配置或排查覆盖率缺口时，运行 `pnpm test:coverage`。
浏览器测试见 [E2E 指南](./e2e/README.md)。

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

- [部署指南](./docs/zh-CN/deploying.md) — 部署配置与运维。
- [Runtime 协议](./docs/zh-CN/runtime-protocol.md) — 服务器与 Agent 的通信。
- [Provider CLI](./docs/zh-CN/direct-provider-cli.md) — Codex 和 Claude Code 集成。
- [可观测性](./docs/zh-CN/observability.md) — 服务器追踪与诊断。
- [发布指南](./docs/zh-CN/releasing.md) — 通过 GitHub Actions 发布。
