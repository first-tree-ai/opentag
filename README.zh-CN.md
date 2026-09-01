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

OpenTag 当前处于 pre-alpha 阶段。仓库提供了一个用于本地 PostgreSQL 依赖的简单 Docker Compose 示例：

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: opentag
      POSTGRES_USER: opentag
      POSTGRES_PASSWORD: opentag
    ports:
      - "5432:5432"
    volumes:
      - opentag-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opentag -d opentag"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 5s

volumes:
  opentag-postgres-data:
```

启动依赖服务：

```bash
docker compose up -d postgres
```

Compose 服务只是本地开发依赖，不会启动 OpenTag Server 或 Agent Runtime。Node.js 配置、Server 启动、Account
bootstrap、Computer enrollment、认证和 Agent 管理方式，请参阅[开发指南](./DEVELOPMENT.zh-CN.md)。

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
- [商标](./TRADEMARKS.zh-CN.md)

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。

界面中出现的其它公司标识用于指明其产品。各标识的归属与我们遵守的条件见
[TRADEMARKS.zh-CN.md](./TRADEMARKS.zh-CN.md)。
