# OpenTag 开发指南

> Canonical source: [DEVELOPMENT.md](./DEVELOPMENT.md)
> Last synced with: 2026-08-17

## 前置要求

- Node.js 22.13 或更高版本（推荐 Node.js 24）
- Corepack 和 pnpm 10.12.1
- Docker 及 Compose 支持（仅运行本地 PostgreSQL 服务时需要）

## 初始化

```bash
corepack enable
pnpm install
```

仓库已在 `package.json` 中固定 pnpm 版本。请勿使用 npm 或 Yarn 更新依赖。

## 验证

```bash
pnpm check
pnpm build
pnpm typecheck
pnpm test
```

仅检查 lint 可运行 `pnpm lint`；应用 Biome 格式化可运行 `pnpm format`。

## 运行健康检查链路

构建 workspace 后启动 Server：

```bash
pnpm build
pnpm --filter @opentag/server start
```

Server 默认监听 `http://127.0.0.1:8000`。在另一个终端中运行：

```bash
pnpm --filter @opentag/cli start doctor
```

可以通过 `--server-url` 或 `OPENTAG_SERVER_URL` 指定其他 Server URL：

```bash
pnpm --filter @opentag/cli start doctor --server-url http://127.0.0.1:9000
```

## 本地 PostgreSQL

PostgreSQL 仅为后续持久化工作预留；当前代码不会连接数据库或运行 migration。

```bash
docker compose up -d postgres
docker compose down
```

服务暴露 `5432` 端口，并使用 `opentag-postgres-data` 命名 volume 保存数据。

## 环境变量

仅在需要本地覆盖时复制 `.env.example`。当前进程不会自动加载环境文件。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server 监听地址 |
| `OPENTAG_PORT` | `8000` | Server 监听端口 |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor 目标地址 |
| `OPENTAG_DATABASE_URL` | 本地 PostgreSQL URL | 为后续持久化工作预留 |

如果 `doctor` 失败，其错误类别会区分配置、网络、HTTP 和无效响应。请确认 Server 已启动，且配置的 URL 指向其基础地址。
