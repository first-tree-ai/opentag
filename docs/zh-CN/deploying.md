# OpenTag 部署指南

> Canonical source: [../deploying.md](../deploying.md)
> Last synced with: 2026-08-19

OpenTag 以单个 Server 容器部署，在同一个端口上提供 REST API、Computer WebSocket 端点和只读 Admin Web，
并需要一个由容器之外提供的 PostgreSQL 实例。本指南介绍发布的镜像、各个镜像 tag 的含义、运行时环境变量
约定，以及 [docker-compose.prod.yml](../../docker-compose.prod.yml) 中的 Compose 栈。

OpenTag 处于 pre-alpha 阶段。产品工作流仍在开发中，首个稳定版本发布前公开 API 可能变化。

## 发布的镜像

`.github/workflows/docker.yml` 发布 `ghcr.io/first-tree-ai/opentag`，且发布 job 只在
`first-tree-ai/opentag` 仓库中运行。所有镜像都是 `linux/amd64`，不发布其他架构。每次构建都附带
maximum 模式的 provenance attestation 和 SBOM。

镜像包含构建后的 Server、已入库的 migration 和 Admin Web 产物；不包含 `open-tag` CLI，也不会内置或启动
PostgreSQL。它以非 root 的 `opentag` 用户从 `/app` 运行，暴露 `8000` 端口，在 `/app/LICENSE` 携带 OpenTag
的 Apache-2.0 许可证，并固定 `NODE_ENV=production`、`OPENTAG_ENV=production`、`OPENTAG_HOST=0.0.0.0`
和 `OPENTAG_PORT=8000`。

正是 `OPENTAG_ENV=production` 使得非 HTTPS 的 `OPENTAG_PUBLIC_URL` 被拒绝，并签发 Secure 浏览器 cookie，
因此镜像前面必须有 TLS 反向代理。内置 `HEALTHCHECK` 访问 `http://127.0.0.1:8000/healthz`，所以在容器内
覆盖 `OPENTAG_PORT` 会让该探针永久失败，即使 Server 本身正常。请改为在宿主机侧发布不同端口，而不是修改
容器端口。

## 镜像 tag

| Tag | 发布时机 | 含义 |
| --- | --- | --- |
| `X.Y.Z` | `vX.Y.Z` release tag | 一个 production release；镜像 tag 去掉前缀 `v` |
| `latest` | `vX.Y.Z` release tag | 指向最新 production release 的移动指针 |
| `edge` | 推送到 `main` | 指向最新 `main` 构建的移动指针 |
| `<full-commit-sha>` | 推送到 `main` 或 `vX.Y.Z` release tag | 该 commit 的精确构建 |

release 部署请固定 `X.Y.Z`，需要锁定某个具体 commit 时固定 40 位完整 commit SHA。该 commit 之后若被发布，
tag 运行会重新构建并以新 digest 重新推送同一个 SHA tag，因此唯一不会移动的固定点是 `X.Y.Z`。`latest` 与
`edge` 是移动
指针：每次发布和每次 `main` 推送都会改变它们的解析结果，因此一次例行 `docker compose pull` 就可能在没有
明确升级决策的情况下替换正在运行的版本。

当你需要的是固定 release 时，不要部署 `edge`。`Docker` workflow 直接响应 `main` 推送，不会等待 `CI`，
因此 `CI` 失败的 commit 同样会产生 `edge` 镜像。分支推送会完全跳过约束 `X.Y.Z` 和 `latest` 的 release
guard：只有 tag 推送才会检查源仓库为 public、tag 匹配 `vX.Y.Z` 且等于 `apps/cli/package.json` 中的版本，
以及被打 tag 的 commit 属于 `main`。

任何镜像构建都不会被后续推送取消。每次运行按 revision 单独分组，因此即使推送接连落地，每个 `main` commit
和每个 release tag 都会得到自己的 commit-SHA 镜像。

## Registry 访问

拉取不需要任何凭据：

```bash
docker pull ghcr.io/first-tree-ai/opentag:X.Y.Z
```

这背后有一个一次性的 maintainer 操作。GHCR 的可见性按 package 单独设置，不会从仓库继承，且新发布的
package 初始为 private。首次发布成功后，打开该 package，进入 Package settings，在 Danger Zone 中选择
Change visibility 并设为 Public。发布 workflow 不会执行这一步，且只需做一次。

## 环境变量

Server 只读取下列变量。必需值缺失或格式非法时，启动会在监听前中止：进程向 stderr 写入
`Failed to start OpenTag server`（其中 secret 值会被脱敏），并以状态码 `1` 退出。

| 变量 | 必需 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `OPENTAG_DATABASE_URL` | 是 | 无 | PostgreSQL 连接地址，scheme 必须是 `postgres:` 或 `postgresql:` |
| `OPENTAG_JWT_SECRET` | 是 | 无 | access token 签名 secret，至少 32 个字符 |
| `OPENTAG_ENCRYPTION_KEY` | 是 | 无 | canonical base64 编码的 32-byte 应用层加密密钥 |
| `OPENTAG_PUBLIC_URL` | 是 | 无 | 浏览器 callback 和邀请链接使用的外部可达 Server origin |
| `OPENTAG_ENV` | 否 | 镜像中为 `production` | 运行环境；`production` 要求 HTTPS 并签发 Secure cookie |
| `OPENTAG_HOST` | 否 | 镜像中为 `0.0.0.0` | 容器内监听地址 |
| `OPENTAG_PORT` | 否 | 镜像中为 `8000` | 容器内监听端口；镜像健康检查固定访问 `8000` |
| `OPENTAG_AUTO_MIGRATE` | 否 | `true` | 监听前执行已入库的 migration，取值只能是 `true` 或 `false` |
| `OPENTAG_ACCESS_TOKEN_TTL_SECONDS` | 否 | `900` | access token 有效期 |
| `OPENTAG_REFRESH_TOKEN_TTL_SECONDS` | 否 | `2592000` | refresh JWT 有效期 |
| `OPENTAG_GOOGLE_CLIENT_ID` | 否 | 无 | Google OIDC client id，必须与 secret 同时配置 |
| `OPENTAG_GOOGLE_CLIENT_SECRET` | 否 | 无 | Google OIDC client secret，必须与 client id 同时配置 |
| `OPENTAG_DEV_AUTH_BYPASS_ENABLED` | 否 | `false` | 仅限 loopback 的开发登录，在 `development` 以外会被拒绝 |
| `OPENTAG_DEV_AUTH_EMAIL` | 否 | 无 | development bypass 选择的已有唯一 bootstrap 用户 |

`OPENTAG_PUBLIC_URL` 必须是纯 origin：发布的镜像固定 `OPENTAG_ENV=production`，会拒绝任何非 HTTPS 的
public URL，schema 还会单独拒绝带凭据、路径、query 或 fragment 的 URL。它是反向代理背后对外可达的地址，
而不是容器地址。

`OPENTAG_DATABASE_URL`、`OPENTAG_JWT_SECRET`、`OPENTAG_ENCRYPTION_KEY` 和 `OPENTAG_GOOGLE_CLIENT_SECRET`
都是 secret。请通过部署环境或不入库的环境文件提供，绝不要提交到本仓库或任何其他仓库。每个部署都要生成
独立的加密密钥；之后若直接更换密钥而不轮换已有邀请，这些邀请会按 fail-closed 原则被拒绝。

```bash
openssl rand -base64 32
```

Google client id 与 secret 会被一起校验，只配置其中一个会导致启动失败。两个开发登录变量只有在
`OPENTAG_ENV` 被显式设为 `development`，且监听地址与 public URL 主机名都是 loopback 时才被接受，因此
部署发布镜像时绝不能设置它们。布尔值只能是字面量 `true` 和 `false`，其他写法都会导致配置解析失败；直接
写入 Compose 文件时还必须加引号。

`OPENTAG_SERVER_URL` 和 `OPENTAG_HOME` 属于 CLI，Server 永远不会读取。四个 `OPENTAG_BOOTSTRAP_*` 值只是
下文一次性 bootstrap 命令的输入。

## 使用 Compose 部署

[docker-compose.prod.yml](../../docker-compose.prod.yml) 会把发布的镜像与一个 PostgreSQL 17 服务一起运行。
请把它复制到独立的部署目录，而不要在仓库 checkout 中直接运行：Compose 会加载该文件所在目录的 `.env`，
而 `.env.example` 中的开发值会给生产镜像一个它拒绝接受的明文 HTTP public URL。

该文件固定 Compose 项目名 `opentag-prod`，因此不会与开发用的 `docker-compose.yml` 共享容器、网络或
`opentag-postgres-data` volume。PostgreSQL 不发布任何宿主机端口，Server 默认把 `8000` 端口发布在
`127.0.0.1` 上。下列变量由 Compose 自己读取，任何 OpenTag 进程都不会看到它们：

| 变量 | 必需 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `OPENTAG_IMAGE` | 否 | `ghcr.io/first-tree-ai/opentag:latest` | `server` 与 `migrate` 服务使用的镜像引用 |
| `OPENTAG_HTTP_BIND` | 否 | `127.0.0.1:8000` | Server 端口发布到的宿主机地址 |
| `OPENTAG_POSTGRES_PASSWORD` | 是 | 无 | 内置 PostgreSQL 服务的密码 |
| `OPENTAG_POSTGRES_USER` | 否 | `opentag` | 内置 PostgreSQL 服务创建的角色 |
| `OPENTAG_POSTGRES_DB` | 否 | `opentag` | 内置 PostgreSQL 服务创建的数据库 |

在 Compose 文件旁创建一个不入库的 `.env`。`OPENTAG_DATABASE_URL` 与上面的 PostgreSQL 凭据相互独立：
两处密码必须一致，URL 中的密码需要 percent-encode，主机名使用 `postgres` 服务名。请把 `X.Y.Z` 替换为要
部署的 release，并把每个 `replace-with-` 占位值替换为生成的真实值。

```text
OPENTAG_IMAGE=ghcr.io/first-tree-ai/opentag:X.Y.Z
OPENTAG_PUBLIC_URL=https://opentag.example.com
OPENTAG_POSTGRES_PASSWORD=replace-with-a-generated-password
OPENTAG_DATABASE_URL=postgresql://opentag:replace-with-a-generated-password@postgres:5432/opentag
OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
OPENTAG_ENCRYPTION_KEY=replace-with-openssl-rand-base64-32
```

启动前先验证变量插值。必需变量缺失时，命令会带着具名错误中止，而不会启动一个配置不完整的部署。

```bash
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.prod.yml up -d
```

`up` 会先启动 PostgreSQL，等待其 `pg_isready` 健康检查通过后再启动 Server。请把 TLS 反向代理指向已发布的
端口，并让它恰好以 `OPENTAG_PUBLIC_URL` 对外提供服务：请求 `Origin` 与该 origin 不一致时浏览器 mutation
会被拒绝；public URL 不能带路径，因此无法部署在子路径下；`/api/v1/computer/ws` 需要转发 `Upgrade` 和
`Connection` 头，Computer 才能连接。

## Migration

`OPENTAG_AUTO_MIGRATE` 默认为 `true`，Server 会在监听前持有 PostgreSQL advisory lock 并执行已入库的
migration。并发副本会在该锁上串行执行，因此全新部署不需要单独的 migration 步骤。

受控发布可设置 `OPENTAG_AUTO_MIGRATE=false`。此时 Server 只做校验而不执行 migration，并在数据库为空、
落后于已入库 migration、超前于它们或与其分叉时拒绝启动。请在每次部署前使用一次性 `migrate` 服务显式执行
migration，`up` 不会启动该服务：

```bash
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
```

该服务使用同一个镜像运行 `node packages/server/dist/db/migrate-cli.mjs`，且只接收 `OPENTAG_DATABASE_URL`。
发布的镜像不包含 CLI，因此这些 `node` 入口是容器内仅有的管理命令。

## 首个管理员

在执行一次性 bootstrap 之前，新部署没有任何账号。它会在单个事务中创建首个用户、Team、admin membership 和
connect code；一旦已存在任何用户，它会以 `Bootstrap has already been completed` 失败。请在运行中的 Server
容器内执行：

```bash
docker compose -f docker-compose.prod.yml exec \
  --env OPENTAG_BOOTSTRAP_EMAIL=admin@example.com \
  --env OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin \
  --env OPENTAG_BOOTSTRAP_TEAM_NAME=example \
  --env OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example \
  server node packages/server/dist/admin/bootstrap-cli.mjs
```

命令会输出一行 JSON，包含 `userId`、`teamId`、`connectCode` 和 `expiresAt`。connect code 是签发后 15 分钟
过期的有效凭据；请直接交给首个管理员，不要写入日志、工单或版本控制。运行中的 Server 永远不会读取这四个
`OPENTAG_BOOTSTRAP_*` 值。

由于镜像不包含 CLI，管理员需要在自己的机器上对着 public origin 兑换该 code：

```bash
npm install --global open-tag
opentag login <connect-code> --server https://opentag.example.com
```

`/admin/` 的浏览器登录通过 Google 完成。创建 Google Web OAuth client，将 callback 配置为
`https://opentag.example.com/api/v1/auth/google/callback`，然后设置 `OPENTAG_GOOGLE_CLIENT_ID` 和
`OPENTAG_GOOGLE_CLIENT_SECRET`。membership 与邀请变更仍是显式 CLI 操作；Admin Web 是只读的。

## 健康探针

监听器一旦开始接受连接，`/healthz` 就返回 `200` 与 `{"status":"ok","service":"opentag-server"}`。它完全
不访问 PostgreSQL，因此在数据库不可达时也会报告容器健康。它只适合作为 liveness 探针。

只有在配置解析、migration、应用装配和监听全部完成后，`/readyz` 才返回 `200` 与 `{"status":"ready"}`；
在此之前返回 `503`、`{"status":"not_ready"}` 和已完成的阶段列表。负载均衡、发布 gate 和编排系统应使用
它。两个路径都不带版本号，且位于 `/api/v1` 之外。

镜像自身的 `HEALTHCHECK` 探测 `/healthz`；`docker-compose.prod.yml` 把 Server 健康检查覆盖为 `/readyz`，
并设置 60 秒 start period，避免冷库 migration 期间过早被判定为健康。

```bash
docker compose -f docker-compose.prod.yml ps
curl --fail --silent http://127.0.0.1:8000/readyz
```

容器反复重启说明配置解析或 migration 失败。请先查看它的输出；启动错误会指出出问题的变量，并对 secret
值脱敏。

```bash
docker compose -f docker-compose.prod.yml logs server
```

## 升级与回滚

每次升级前先备份 PostgreSQL。把 `OPENTAG_IMAGE` 改为要部署的 release，拉取镜像，然后重建 Server：

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

新容器会在监听前执行新增的 migration，在此期间 `/readyz` 保持 `503`。若设置了 `OPENTAG_AUTO_MIGRATE=false`，
请在 pull 之后、重建之前运行 `migrate` 服务。

回滚并不对称。migration 是单向的，设置了 `OPENTAG_AUTO_MIGRATE=false` 的旧版 Server 会拒绝在包含它不认识
的 migration 的数据库上启动。只有在 schema 没有变化时，把 `OPENTAG_IMAGE` 恢复为上一个值才是安全的；
否则请恢复升级前备份的数据库。
