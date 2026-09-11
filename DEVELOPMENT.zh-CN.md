# OpenTag 开发指南

> 权威来源：[DEVELOPMENT.md](./DEVELOPMENT.md)
> 同步日期：2026-09-11

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

### Skill 同步

daemon 会把分配给每个 Agent 的 skill 镜像到该 Agent 的 Home 目录：

| 路径 | 内容 |
| --- | --- |
| `<Agent Home>/.skills/<name>/` | skill 的文件，与服务器 manifest 完全一致 |
| `<Agent Home>/.skills/.opentag-skills.json` | 本地同步记录（`0600`）：agent digest、每个 skill 的 digest 与 manifest、`syncedAt` 和 `lastError` |
| `<Agent Home>/.claude/skills/<name>` | 指向 `../../.skills/<name>` 的相对符号链接，供 Claude Code 发现 skill |
| `data/runtime/workspace-states/a-<hash>.json` | workspace 布局状态；schema 版本 4 增加了最近一次同步结果 |

`.skills/` 完全由 daemon 托管：同步会安装服务器分配的 skill、删除服务器不再列出的 skill，且绝不触碰
`.claude/skills/` 下的其他条目（例如 `context-tree-*`）。同步在 workspace 准备完成、服务器推送 `skills:changed`
帧以及每十分钟一次的兜底扫描时运行；失败会记录到 `lastError` 并按指数退避（1 分钟到 30 分钟）重试，不会阻塞
Session 启动。Codex 从整机共享的 `$CODEX_HOME/skills` 读取 skill，所有 Agent 共用该目录，因此暂不为 Codex 做
按 Agent 的投影。

通过 CLI 管理 skill 库：

```bash
opentag skill list
opentag skill show <name>
opentag skill push <dir-or-zip> [--replace]
opentag skill pull <name> [--out <dir>]
opentag skill delete <name> [--yes]
opentag skill assign <agent-id-or-name> --set <names...>
```

`push` 会把目录打包为 zip（跳过 `.git/`、`node_modules/` 和 `.DS_Store`；压缩后不超过 5 MiB、解压不超过
20 MiB、文件数不超过 200），并要求根目录有 `SKILL.md`。在 Agent Session 内执行时会通过该 Session 发布并把 skill
分配给该 Agent；请用 `--session <session-id>` 传入托管指令中给出的 Current Session。

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
