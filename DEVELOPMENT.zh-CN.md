# OpenTag 开发指南

> Canonical source: [DEVELOPMENT.md](./DEVELOPMENT.md)
> Last synced with: 2026-08-19

## 前置要求

- Node.js 22.x（最低 22.13）、Node.js 24.x 或 Node.js 26.x（使用最新补丁版本；主力版本为 Node.js 24）
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
pnpm --filter @opentag/server test:integration
```

仅检查 lint 可运行 `pnpm lint`；应用 Biome 格式化可运行 `pnpm format`。

Pull Request 的必过检查是稳定的 `CI` fan-in job。它会覆盖上述命令、source/staging CLI tarball 安装、生产容器
健康检查和受支持的 Node.js 版本。完整验证与发布使用 Node.js 24；兼容 job 会在精确下限 Node.js 22.13.0 和
最新 Node.js 26 上运行 `pnpm check:node-compat`，完成构建、测试和 CLI tarball 安装。Node.js 23 与 25 已 EOL，
不在支持范围内。构建后可在本地验证当前 source tarball：

~~~bash
node scripts/cli-pack-smoke.mjs \
  --channel source \
  --name open-tag \
  --version 0.0.1 \
  --binary opentag-dev
~~~

## 运行 Server 与健康检查链路

先启动 PostgreSQL，配置必需的数据库地址和 JWT secret，再构建并启动 Server。Server 会在开始监听前执行
migration。

```bash
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
pnpm build
pnpm --filter @opentag/server start
```

Server 默认监听 `http://127.0.0.1:8000`。在另一个终端中运行：

```bash
pnpm --filter open-tag start doctor
```

可以通过 `--server-url` 或 `OPENTAG_SERVER_URL` 指定其他 Server URL：

```bash
pnpm --filter open-tag start doctor --server-url http://127.0.0.1:9000
```

## 本地 PostgreSQL

本地 PostgreSQL 服务用于 migration 和认证开发：

```bash
docker compose up -d postgres
pnpm --filter @opentag/server db:migrate
docker compose down
```

服务暴露 `5432` 端口，并使用 `opentag-postgres-data` 命名 volume 保存数据。
生产 Server 镜像不会内置或启动 PostgreSQL。部署时通过 `OPENTAG_DATABASE_URL` 指向独立管理的 PostgreSQL
实例；上面的 Compose 服务仅用于本地开发。独立的 `docker-compose.prod.yml` 会把已发布的镜像与它自己的
PostgreSQL 服务一起运行，详见 [docs/zh-CN/deploying.md](./docs/zh-CN/deploying.md)。

初始化空安装时，设置必需的 bootstrap 字段并运行一次性管理员命令。该命令会先迁移空数据库，再创建首个
用户、team、admin membership 和 connect code。

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_TEAM_NAME=example
export OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
pnpm --filter open-tag start login <connect-code>
```

源码 checkout 属于 `dev` channel。打包后暴露 `opentag-dev` binary，默认使用 `~/.opentag-dev`；staging 与
production build 分别使用 `opentag-staging` / `~/.opentag-staging` 和 `opentag` / `~/.opentag`。显式设置
`OPENTAG_HOME` 会覆盖 channel 默认值。

Linux/macOS 上登录会安装并启动用户服务。在另一个终端检查服务和当前用户所有的 Computer：

```bash
pnpm --filter open-tag start daemon status
pnpm --filter open-tag start computer list
```

daemon 会复用 home 中的稳定 Computer ID，每次服务启动创建新的进程 instance，并连接
`/api/v1/computer/ws`。使用 `daemon install/start/stop/restart/status/uninstall` 管理服务；`uninstall` 会保留
凭据和 Computer identity。只需写入凭据时使用 `login --no-start`；v0.1 不支持 Windows daemon 服务。
Linux 日志通过 `journalctl --user -u opentag-dev.service` 查看，macOS 日志位于 channel home 的 `logs`
目录。可选的 `${OPENTAG_HOME}/daemon.env` 必须是私有普通文件（权限 `0600`），用于补充服务环境且不会
覆盖固定的服务配置。CLI 使用 `/api/v1/auth/...` 与 `/api/v1/me/...`；`/healthz` 和 `/readyz` 继续作为
无版本部署探针。

dev 服务定义在 Linux 上位于 `~/.config/systemd/user/opentag-dev.service`，在 macOS 上位于
`~/Library/LaunchAgents/opentag-dev.plist`；macOS wrapper 位于 `${OPENTAG_HOME}/service/opentag-dev`。
staging 与 production 使用各自的 channel `serviceId`（`opentag-staging` 或 `opentag`）替换后缀。如果登录已
保存凭据但服务安装失败，修复提示的 manager 问题后运行 `opentag-dev daemon install`，不需要申请新的
connect code。

## 管理 Agent 配置

Agent 属于 Team，并在创建时固定绑定到 manager 自己拥有的一台 Computer。当前用户只有一个 Team 和一台
Computer 时，两者会自动选择：

```bash
pnpm --filter open-tag start agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
pnpm --filter open-tag start agent list
```

存在多个选项时，使用 `--team <canonical-name>` 或 `--computer <uuid>`。Computer 离线时仍可选择，因为 online
presence 不是 Agent 配置状态。可以查看或修改可变的展示名称：

```bash
pnpm --filter open-tag start agent show <agent-id>
pnpm --filter open-tag start agent update <agent-id> --display-name "Reviewer"
pnpm --filter open-tag start agent delete <agent-id>
```

更新使用 revision compare-and-swap，不会自动覆盖并发变更。删除是 Server 端软删除，对 Agent manager 或 Team
admin 幂等。`claude-code` 是允许的配置值，但其 runtime adapter 以及所有 Session/Turn delivery 仍属于后续工作。

这四个 `OPENTAG_BOOTSTRAP_*` 值仅作为一次性命令的输入，运行中的 Server 不会读取它们。
bootstrap email 是账号资料，不是邮箱密码凭据。当前 connect code 流程先解析稳定的 user ID，再进入与 provider
无关的 token 颁发边界。未来 Google 或 OIDC identity resolver 可以接入这个边界，无需改变 JWT claims 或 team
权限模型；每次鉴权始终从 PostgreSQL 读取有效 membership。

## Google 登录、Team membership 与 Admin Web

创建 Google Web OAuth client，并将 callback 配置为
`http://127.0.0.1:8000/api/v1/auth/google/callback`，然后设置 `OPENTAG_GOOGLE_CLIENT_ID` 与
`OPENTAG_GOOGLE_CLIENT_SECRET`。Server 会在监听前校验 Google 配置；生产环境的 `OPENTAG_PUBLIC_URL` 必须
使用 HTTPS。浏览器 access/refresh JWT 只保存在 HttpOnly cookie 中，浏览器 mutation 还必须同时通过同源检查
和可读 double-submit CSRF cookie 校验。

若本地 loopback 开发环境没有 Google 凭据，可显式启用开发 bypass，并指定一个已有 bootstrap 用户：

```bash
export OPENTAG_ENV=development
export OPENTAG_DEV_AUTH_BYPASS_ENABLED=true
export OPENTAG_DEV_AUTH_EMAIL=admin@example.com
```

`OPENTAG_HOST` 与 `OPENTAG_PUBLIC_URL` 都必须保持为 loopback 地址。登录页随后会显示
`Dev: bypass Google`。callback 会按不区分大小写的 email 精确解析唯一一个已有用户并签发正常浏览器 session；
它不会创建用户或 Team，且仍会拒绝 suspended 用户或没有 active membership 的用户。email 不存在或有重复匹配时
会 fail closed。Server 会在 `test` 和 `production` 环境拒绝这组配置。

打开 `/admin/` 可使用只读 Team 管理界面。membership 与邀请变更使用 CLI：

```bash
pnpm --filter open-tag start team member list --team example
pnpm --filter open-tag start team member role <user-id> --role admin --team example
pnpm --filter open-tag start team member remove <user-id> --team example
pnpm --filter open-tag start team member restore <user-id> --role member --team example
pnpm --filter open-tag start team leave --team example
pnpm --filter open-tag start team invitation show --team example
pnpm --filter open-tag start team invitation rotate --team example
```

邀请明文只在授权的 `show`/`rotate` 响应中恢复；PostgreSQL 保存 SHA-256 查询 hash 和 AES-256-GCM 密文。
使用 `openssl rand -base64 32` 生成 `OPENTAG_ENCRYPTION_KEY`；若直接更换密钥而不轮换已有邀请，旧邀请会按
fail-closed 原则拒绝读取。

## 环境变量

仅在需要本地覆盖时复制 `.env.example`。当前进程不会自动加载环境文件。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server 监听地址 |
| `OPENTAG_PORT` | `8000` | Server 监听端口 |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor 目标地址 |
| `OPENTAG_PUBLIC_URL` | 无 | 浏览器 callback 和邀请链接使用的必需 Server 公共 origin |
| `OPENTAG_DATABASE_URL` | 无 | 必需的 PostgreSQL 连接地址 |
| `OPENTAG_JWT_SECRET` | 无 | 必需的 access token 签名 secret，至少 32 个字符 |
| `OPENTAG_ENCRYPTION_KEY` | 无 | 必需的 canonical base64 编码 32-byte 应用层加密密钥 |
| `OPENTAG_GOOGLE_CLIENT_ID` | 无 | 可选 Google OIDC client id，必须与 secret 同时配置 |
| `OPENTAG_GOOGLE_CLIENT_SECRET` | 无 | 可选 Google OIDC client secret，必须与 client id 同时配置 |
| `OPENTAG_DEV_AUTH_BYPASS_ENABLED` | `false` | 显式启用仅限 loopback 的开发登录，必须同时配置 email |
| `OPENTAG_DEV_AUTH_EMAIL` | 无 | development bypass 选择的已有唯一 bootstrap 用户 |
| `OPENTAG_AUTO_MIGRATE` | `true` | 监听前执行已入库的 migration |
| `OPENTAG_ACCESS_TOKEN_TTL_SECONDS` | `900` | access token 有效期 |
| `OPENTAG_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | refresh JWT 有效期 |
| `OPENTAG_HOME` | 随 channel 而定 | CLI credentials、Computer identity 与 daemon ownership 目录（源码默认为 `~/.opentag-dev`） |

如果 `doctor` 失败，其错误类别会区分配置、网络、HTTP 和无效响应。请确认 Server 已启动，且配置的 URL 指向其基础地址。

## 部署

部署运行已发布的 `ghcr.io/first-tree-ai/opentag` 镜像，而不是源码 checkout。该镜像在同一个端口提供 API、
Computer WebSocket 端点和 Admin Web，需要在 TLS 反向代理后使用 HTTPS 的 `OPENTAG_PUBLIC_URL`，且不包含
CLI。镜像 tag 选择、运行时环境变量约定、`docker-compose.prod.yml`、migration、首个管理员 bootstrap 和升级
步骤请参阅 [docs/zh-CN/deploying.md](./docs/zh-CN/deploying.md)。

## 发布

发布只能由 GitHub Actions 和 npm trusted publishing 执行。禁止从维护者机器发布任一 channel，也禁止向仓库
添加长期 npm token。channel identity、发布 guard、package smoke 和恢复步骤请参阅
[docs/zh-CN/releasing.md](./docs/zh-CN/releasing.md)。
