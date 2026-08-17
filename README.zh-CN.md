# OpenTag

> Canonical source: [README.md](./README.md)
> Last synced with: 2026-08-17

OpenTag 是一个全新的独立开源产品，用于连接团队即时通信与 AI 编码 Agent。项目目前处于 **pre-alpha**
阶段：产品工作流仍在开发中，尚不适合生产使用。

当前仓库只提供 OpenTag 的工程底座：

- 包含 CLI、Client、Server 和 Shared 的 TypeScript monorepo；
- Fastify Server 健康检查端点；
- 会校验 schema 的 Client 健康检查；
- `opentag doctor` 命令；
- 为后续持久化工作准备的本地 PostgreSQL 17 开发服务。

仓库尚未实现即时通信集成、Agent Provider、Session Runtime 或数据库 schema。

## 快速开始

前置要求：Node.js 22.13 或更高版本、Corepack 和 pnpm 10.12.1。

```bash
corepack enable
pnpm install
pnpm build
pnpm --filter @opentag/server start
```

在另一个终端中运行：

```bash
pnpm --filter open-tag start doctor
```

完整本地工作流请参阅 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)。

## 项目状态

OpenTag 正通过小型、可验证的纵向切片逐步构建。首个稳定版本发布前，公开 API 和 package 边界可能变化。
当前代码只证明上述仓库工具链和健康检查路径。

## 文档

- [开发指南](./DEVELOPMENT.zh-CN.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [安全政策](./SECURITY.zh-CN.md)
- [行为准则](./CODE_OF_CONDUCT.zh-CN.md)

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。
