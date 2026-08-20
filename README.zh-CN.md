# OpenTag

> Canonical source: [README.md](./README.md)
> Last synced with: 2026-08-19

OpenTag 是一个全新的独立开源产品，用于连接团队即时通信与 AI 编码 Agent。项目目前处于 **pre-alpha**
阶段：产品工作流仍在开发中，尚不适合生产使用。

当前仓库提供 OpenTag 的工程底座和首个控制面纵向切片：

- 包含 CLI、Web、Client、Server 和 Shared 的 TypeScript monorepo；
- 带健康、就绪、REST 与 Computer WebSocket 端点的 Fastify Server；
- 会校验 schema 的 Client 健康检查；
- 与 provider 无关的账号身份、Google 浏览器登录和 PostgreSQL migration；
- 使用滑动续期无状态 refresh JWT 的一次性 connect code 登录；
- 显式 Team membership、角色、离开/移除/恢复和七天邀请链接生命周期；
- 用户所有的 Computer 注册与在线状态；
- Team 所有的 Agent Registry、不可变 Computer/provider 绑定与 revision fencing；
- 同源只读 Admin Web，以及 `doctor`、`login`、`team`、`agent`、`computer` 和 daemon 服务管理命令。

仓库尚未实现 Agent 执行、飞书/Slack 集成、IM 持久化或 Session Runtime。

## 快速开始

前置要求：Node.js 22.x（最低 22.13）、Node.js 24.x 或 Node.js 26.x，以及 Corepack 和 pnpm 10.12.1。

```bash
corepack enable
pnpm install
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
pnpm build
pnpm --filter @opentag/server start
```

在另一个终端中执行一次 bootstrap 与登录。Linux/macOS 上，登录会安装并启动当前用户的 daemon 服务：

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_TEAM_NAME=example
export OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
opentag-dev login <connect-code> --server http://127.0.0.1:8000
opentag-dev daemon status
```

dev installer 会构建并链接 CLI；已有凭据时还会安装、启动或修复 daemon service。首次安装没有凭据时，service
安装会安全地延后到独立的 `login`，由 `login` 创建凭据并安装 service。将 `~/.local/bin` 放在 `PATH` 最前，
还能保证 service definition 使用当前 checkout 刚构建的 CLI，而非旧 shim。运行 `opentag-dev computer list`
可以看到 Computer 为 online。使用 `daemon stop`、`start`、
`restart`、`status` 与 `uninstall` 管理生命周期。只需保存凭据时使用 `login --no-start`。v0.1 不支持
Windows daemon 服务。

daemon 注册后，可以创建并查看 Agent 配置：

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

这只会记录 Agent identity 和 Computer binding，不会启动 Codex 或 Claude Code turn。

配置 `OPENTAG_GOOGLE_CLIENT_ID` 和 `OPENTAG_GOOGLE_CLIENT_SECRET` 后即可启用 Google 登录，然后打开
`http://127.0.0.1:8000/`。active Team member 使用同一套 App Shell 和 member-safe 视图；Team Admin 额外管理
Agent、runtime 配置、IM binding 与 Local Computer setup。Computers 页面列出带时间戳的 Team Computer 观测，
Admin 还可以生成短期有效的安装/login 命令。membership 与邀请变更仍通过显式 CLI 操作完成：

若 loopback 开发环境没有 Google 凭据，可设置 `OPENTAG_DEV_AUTH_BYPASS_ENABLED=true`，并将
`OPENTAG_DEV_AUTH_EMAIL` 设为已有 bootstrap 用户的唯一 email。该 bypass 在 `dev` 以外的环境会被拒绝，
且不会创建账号或 Team 角色。

```bash
pnpm --filter open-tag start team member list
pnpm --filter open-tag start team invitation show
pnpm --filter open-tag start team invitation rotate
```

完整本地工作流请参阅 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)。

## 项目状态

OpenTag 正通过小型、可验证的纵向切片逐步构建。首个稳定版本发布前，公开 API 和 package 边界可能变化。
当前代码已建立数据库 bootstrap、用户认证、本地 Computer 连接、Agent Registry、账号/Team 生命周期和只读
Admin Web；Agent 执行与即时通信仍属于后续纵向切片。

## 文档

- [开发指南](./DEVELOPMENT.zh-CN.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [发布指南](./docs/zh-CN/releasing.md)
- [安全政策](./SECURITY.zh-CN.md)
- [行为准则](./CODE_OF_CONDUCT.zh-CN.md)

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。
