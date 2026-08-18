# OpenTag

> Canonical source: [README.md](./README.md)
> Last synced with: 2026-08-18

OpenTag 是一个全新的独立开源产品，用于连接团队即时通信与 AI 编码 Agent。项目目前处于 **pre-alpha**
阶段：产品工作流仍在开发中，尚不适合生产使用。

当前仓库提供 OpenTag 的工程底座和首个控制面纵向切片：

- 包含 CLI、Client、Server 和 Shared 的 TypeScript monorepo；
- 带健康、就绪、REST 与 Computer WebSocket 端点的 Fastify Server；
- 会校验 schema 的 Client 健康检查；
- PostgreSQL migration，以及首个用户和 team 的 bootstrap 认证；
- 使用滑动续期无状态 refresh JWT 的一次性 connect code 登录；
- 用户所有的 Computer 注册与在线状态；
- `opentag-dev doctor`、`login`、`daemon run` 和 `computer list` 命令。

仓库尚未实现即时通信集成、Agent Provider 或 Session Runtime。

## 快速开始

前置要求：Node.js 22.x（最低 22.13）、Node.js 24.x 或 Node.js 26.x，以及 Corepack 和 pnpm 10.12.1。

```bash
corepack enable
pnpm install
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
pnpm build
pnpm --filter @opentag/server start
```

在另一个终端中执行一次 bootstrap 与登录，然后启动前台 daemon：

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_TEAM_NAME=example
export OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
pnpm --filter open-tag start login <connect-code>
pnpm --filter open-tag start daemon run
```

在第三个终端运行 `pnpm --filter open-tag start computer list`，可以看到 Computer 为 online。按 Ctrl+C 停止
前台 daemon 后再次查询，应显示 offline。

完整本地工作流请参阅 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)。

## 项目状态

OpenTag 正通过小型、可验证的纵向切片逐步构建。首个稳定版本发布前，公开 API 和 package 边界可能变化。
当前代码已建立数据库 bootstrap、用户认证与本地 Computer 连接；Agent 执行与即时通信仍属于后续纵向切片。

## 文档

- [开发指南](./DEVELOPMENT.zh-CN.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [发布指南](./docs/zh-CN/releasing.md)
- [安全政策](./SECURITY.zh-CN.md)
- [行为准则](./CODE_OF_CONDUCT.zh-CN.md)

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。
