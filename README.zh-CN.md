# OpenTag

> Canonical source: [README.md](./README.md)
> Last synced with: 2026-08-26

OpenTag 是一个全新的独立开源产品，用于连接即时通信与 AI 编码 Agent。项目目前处于 **pre-alpha**
阶段：产品工作流仍在开发中，尚不适合生产使用。

当前仓库提供 OpenTag 的工程底座和首个控制面纵向切片：

- 包含 CLI、Web、Client、Server 和 Shared 的 TypeScript monorepo；
- 带健康、就绪、REST 与 Computer WebSocket 端点的 Fastify Server；
- 会校验 schema 的 Client 健康检查；
- 与 provider 无关的账号身份、Google 浏览器登录和 PostgreSQL migration；
- 使用滑动续期无状态 refresh JWT 的一次性 Account 登录 code；
- 独立认证的 Computer enrollment 与在线状态；
- 带不可变 Computer/provider 绑定与 revision fencing 的 Agent Registry；
- 持久化 Agent Runtime 执行、delivery custody、上报与恢复；
- 飞书和 Slack 入站标准化、持久化及 Channel/Thread Session 路由；
- 带显式消息重试的持久化、best-effort internal Session collaboration；
- 供 Agent 自主回复和 Reaction 的 provider CLI 凭证交接；
- 同源管理 Web，以及 `doctor`、`login`、`agent`、`computer` 和 daemon 服务管理命令。

这些 Runtime 与消息路径已经实现，但仍处于 pre-alpha 阶段；安装、管理和端到端产品工作流仍在完善。

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

在另一个终端中 bootstrap 首个 Account，再兑换输出的 Account 登录 code。命令名与
`OPENTAG_BOOTSTRAP_WORKSPACE_*` 输入会作为兼容接口保留到 Phase 2：

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_WORKSPACE_NAME=example
export OPENTAG_BOOTSTRAP_WORKSPACE_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
opentag-dev login --server http://127.0.0.1:8000 -- <connect-code>
```

Account credential 只用于管理面，不会启动 daemon。打开 Web，从 Agents 区域生成 15 分钟有效的 Computer
连接命令，再在执行主机运行其中的 `opentag-dev computer connect --server ... <code>`。该命令保存 enrollment
范围的 machine credential，并在 Linux/macOS 上安装或重启当前用户的 daemon service。将 `~/.local/bin` 放在
`PATH` 最前，可保证 service definition 使用当前 checkout 刚构建的 CLI，而非旧 shim。运行
`opentag-dev computer list` 可看到已 enrollment 的 Computer 为 online。使用 `daemon stop`、`start`、
`restart`、`status` 与 `uninstall` 管理生命周期；只保存 machine credential 时使用
`computer connect --no-start`。v0.1 不支持 Windows daemon 服务。

daemon 注册后，可以创建并查看 Agent 配置：

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

这会记录 Agent identity 和 Computer binding。Agent 收到已准入工作后，Agent Runtime turn 才会启动。

已登录 Account 可在可用 Codex Agent 的 **Runtime** 页面或对应的 `agent update` 参数中管理 model、reasoning effort
和单个 Turn 的最长执行时间。model 或 reasoning 留空表示交由 Codex 管理；duration 留空则使用 OpenTag 的 30 分钟默认值。
显式填写的 Codex-native 值会在绑定 Computer 准备 Runtime 时校验，OpenTag 不会静默替换。Claude Code 的
Effective Runtime Snapshot 目前尚未支持。

配置 `OPENTAG_GOOGLE_CLIENT_ID` 和 `OPENTAG_GOOGLE_CLIENT_SECRET` 后即可启用 Google 登录，然后打开
`http://127.0.0.1:8000/`。已登录 Account 管理其内部兼容 scope 中可用的 Agents、Tasks、Skills 与 Integrations；
Computer enrollment 和诊断从 Agents 区域进入。已确认的产品方向与产品呈现是
**Account → Computer enrollment → Agent → IM binding**；Phase 1 尚未把它实现为严格的 per-Account schema invariant。
OpenTag 不提供 Workspace、Admin 或 invitation 管理面。数据库仍会配置内部默认 Workspace 与 grant，作为 Phase 2
前的兼容 seam。legacy active grant 可能让多个 Account 管理同一批 Agent 与 Computer enrollment，直到一次性数据拆分
和 Phase 2 建立严格 ownership。这些兼容记录不是共享协作容器。

Internal Session collaboration 是 Agent Runtime 能力，不是 Workspace、Project 或其他管理实体。它不定义跨 Agent
所有权，也不拥有共享文件、长期记忆、Tasks、Secrets 或 billing。Context Tree 可以独立保存长期上下文，与这条实时
Session 消息边界正交。

若 loopback 开发环境没有 Google 凭据，可设置 `OPENTAG_DEV_AUTH_BYPASS_ENABLED=true`，并将
`OPENTAG_DEV_AUTH_EMAIL` 设为已有 bootstrap 用户的唯一 email。该 bypass 在 `dev` 以外的环境会被拒绝，
且不会创建 Account 或兼容 grant。

完整本地工作流请参阅 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)。

## 项目状态

OpenTag 正通过小型、可验证的纵向切片逐步构建。首个稳定版本发布前，公开 API 和 package 边界可能变化。
当前代码已包含控制面、本地 Computer 连接、Agent Runtime、持久 IM delivery、飞书/Slack 入站路由、
Channel/Thread Session 与 provider CLI 直接交接。更广泛的产品与跨 Agent 协作工作流仍在开发中。

## 文档

- [开发指南](./DEVELOPMENT.zh-CN.md)
- [Server 可观测性](./docs/zh-CN/observability.md)
- [直接使用 Provider CLI 发送消息](./docs/zh-CN/direct-provider-cli.md)
- [Slack App 配置](./docs/zh-CN/slack-app-setup.md)
- [IM Channel 与 Thread Session](./docs/zh-CN/thread-sessions.md)
- [Internal Session collaboration](./docs/zh-CN/internal-session-collaboration.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [发布指南](./docs/zh-CN/releasing.md)
- [部署指南](./docs/zh-CN/deploying.md)
- [安全政策](./SECURITY.zh-CN.md)
- [行为准则](./CODE_OF_CONDUCT.zh-CN.md)

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。
