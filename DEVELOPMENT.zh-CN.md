# OpenTag 开发指南

> Canonical source: [DEVELOPMENT.md](./DEVELOPMENT.md)
> Last synced with: 2026-08-20

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
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm test:coverage
pnpm --filter @opentag/server test:integration
```

仅检查 lint 可运行 `pnpm lint`；应用 Biome 格式化可运行 `pnpm format`。

`pnpm test:coverage` 会先构建 workspace，再统计 CLI、Web、Shared、Client 和 Server 的离线单测覆盖率。它会纳入
未被测试 import 的生产源码，但排除根目录 `scripts/`、Server PostgreSQL integration tests 和 Provider E2E。
统一报告目前用于测量基线、定位缺口和安排优先级，暂不设置全仓或分 workspace 覆盖率阈值。只有在重复运行的
统计结果稳定后，才应增加回退阈值。Agent Runtime 继续使用 `packages/client/vitest.agent-runtime.config.ts` 中
独立的 100% 门槛，并由
`pnpm --filter @opentag/client test:agent-runtime:coverage` 执行。

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
实例；上面的 Compose 服务仅用于本地开发。

初始化空安装时，设置必需的 bootstrap 字段并运行一次性管理员命令。该命令会先迁移空数据库，再创建首个
用户、team、admin membership 和 connect code。

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_TEAM_NAME=example
export OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin
./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
opentag-dev login --server http://127.0.0.1:8000 -- <connect-code>
```

源码 checkout 属于 `dev` channel。`scripts/dev-install.sh` 会构建完整 workspace，将 channel config 指定的 dev
binary 链接到 `~/.local/bin/opentag-dev`，执行验证，并在已有凭据时修复 daemon service。首次安装没有凭据，
因此 service 安装会明确延后到独立的 `login`；installer 不消费 connect code，职责与发布 installer 保持一致。
同时应把 `~/.local/bin` 放在 `PATH` 最前，避免 service reconciliation 选中旧的 `opentag-dev` shim。dev
channel 默认使用 `~/.opentag-dev`；staging 与
production build 分别使用 `opentag-staging` / `~/.opentag-staging` 和 `opentag` / `~/.opentag`。显式设置
`OPENTAG_HOME` 会覆盖 channel 默认值。

Linux/macOS 上登录会安装并启动用户服务。在另一个终端检查服务和当前用户所有的 Computer：

```bash
opentag-dev daemon status
opentag-dev computer list
```

daemon 会复用 `${OPENTAG_HOME}/config/computer.json` 中的稳定 Computer ID，每次服务启动创建新的进程
instance，并连接 `/api/v1/computer/ws`。OpenTag Home 按生命周期组织：

```text
${OPENTAG_HOME}/
├── config/
│   ├── credentials.json
│   ├── computer.json
│   └── daemon.env
├── data/
│   ├── runtime/
│   │   ├── session-bindings/<agent-key>/<session-key>.json
│   │   └── effective-snapshots/<agent-key>/<snapshot-key>.json
│   └── workspaces/<agent-key>/  # Agent cwd 与可写根目录
├── state/
│   ├── daemon/owner.json
│   └── service/
│       ├── operation.json
│       ├── target-operation.json  # 仅默认 channel Home
│       └── <serviceId>
└── logs/
```

目录权限为私有 `0700`；credentials、identity、runtime recovery record 与 lease 文件均为私有普通文件
（`0600`）。各目录和文件只在对应 owner 需要时创建。特别地，`login --no-start` 只创建
`config/credentials.json`；runtime recovery record 和 Workspace 在首次相关 reconcile 时才出现。

OpenTag 不会在 Agent Workspace 内维护控制文件。Platform 与 Agent instructions 通过所选 Provider 的原生系统
提示词接口注入。Workspace 根目录直接作为 Provider cwd。Client 只创建并校验该私有根目录，除此之外将目录
内容视为用户所有：不会检查、迁移、重命名或删除 Workspace entry，也不会读取废弃的 workspace-state
record。旧 Client 写在 `workspaces/<agent-key>/files/` 下的数据会原样保留为普通 `files/` 子目录；如需调整
布局，应先备份并由用户手动整理。

此布局采用 clean break：OpenTag 不会读取、迁移、删除或回退到根目录的 `credentials.json`、
`computer.json`、`daemon-owner.json`、`runtime/`、`service/`，也不会读取 `data/computer.json`、
`data/runtime/agents` 或 `~/.opentag-service-targets`。请使用全新 Home，或先移走旧 Home 再重新登录；
否则旧文件会原样保留，但新版不会使用它们。

### 本地数据丢失与恢复

重新登录只能恢复连接，不能恢复原有的本地执行连续性。Server 可以重新签发 credentials 并重建 effective
snapshot；Provider Runtime 启动或恢复时会重新注入托管 instructions。重新签发的 credentials 不是原值。如果
`config/computer.json` 丢失，当前 Client 会创建新的 Computer identity。Server 虽保留旧 Computer 与 placement
记录，但 Client 不会自动认领旧 identity 或修复旧 binding。

Provider binding、尚未成功上报的 Turn 证据、Workspace 文件和本机 `daemon.env` 值仅存在于本地。Session
binding 丢失会破坏 Provider 精确续接，并可能使已 accepted 但尚未上报的工作需要显式修复。Workspace 文件
只能依赖 Git、外部存储或本机备份，OpenTag Server 无法恢复。Effective snapshot 可重新生成，不属于主要
备份目标。

daemon/service owner、lease state 与日志只有在 daemon 已停止且没有 service mutation 时才可视为本机可重新
生成数据；操作仍在运行时删除 owner 或 lease 证据，会破坏单 daemon 和 service 互斥。备份应重点保护
`config/computer.json`、本机 `config/daemon.env`、`data/runtime/session-bindings` 与 `data/workspaces`。

使用 `daemon install/start/stop/restart/status/uninstall` 管理服务；`uninstall` 会保留 `config/` 与
`data/`。v0.1 不支持 Windows daemon 服务。Linux 日志通过
`journalctl --user -u opentag-dev.service` 查看，macOS 日志位于 `${OPENTAG_HOME}/logs`。可选的
`${OPENTAG_HOME}/config/daemon.env` 必须是私有普通文件（权限 `0600`），用于补充服务环境且不会覆盖固定
的服务配置。CLI 使用 `/api/v1/auth/...` 与 `/api/v1/me/...`；`/healthz` 和 `/readyz` 继续作为无版本部署探针。

dev 服务定义在 Linux 上位于 `~/.config/systemd/user/opentag-dev.service`，在 macOS 上位于
`~/Library/LaunchAgents/opentag-dev.plist`；macOS wrapper 位于
`${OPENTAG_HOME}/state/service/opentag-dev`。
staging 与 production 使用各自的 channel `serviceId`（`opentag-staging` 或 `opentag`）替换后缀。如果登录已
保存凭据但服务安装失败，修复提示的 manager 问题后运行
`opentag-dev daemon install`，不需要申请新的 connect code。

Service mutation 使用两个独立 lease。`${OPENTAG_HOME}/state/service/operation.json` 只序列化当前 Home 的
操作；target lease 固定放在当前用户对应 binary channel 的默认 Home，例如
`~/.opentag-dev/state/service/target-operation.json`。因此多个自定义 `OPENTAG_HOME` 无法并发修改同一个
`opentag-dev.service`。dev、staging、production 各自使用不同默认 Home 和 service target，target lease 之间
不会竞争。

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

## Google 登录、Team membership 与 Web App

创建 Google Web OAuth client，并将 callback 配置为
`http://127.0.0.1:8000/api/v1/auth/google/callback`，然后设置 `OPENTAG_GOOGLE_CLIENT_ID` 与
`OPENTAG_GOOGLE_CLIENT_SECRET`。Server 会在监听前校验 Google 配置；`staging` 和 `prod` 环境的
`OPENTAG_PUBLIC_URL` 必须使用 HTTPS。浏览器 access/refresh JWT 只保存在 HttpOnly cookie 中，浏览器 mutation 还必须同时通过同源检查
和可读 double-submit CSRF cookie 校验。

若本地 loopback 开发环境没有 Google 凭据，可显式启用开发 bypass，并指定一个已有 bootstrap 用户：

```bash
export OPENTAG_ENV=dev
export OPENTAG_DEV_AUTH_BYPASS_ENABLED=true
export OPENTAG_DEV_AUTH_EMAIL=admin@example.com
```

`OPENTAG_HOST` 与 `OPENTAG_PUBLIC_URL` 都必须保持为 loopback 地址。登录页随后会显示
`Dev: bypass Google`。callback 会按不区分大小写的 email 精确解析唯一一个已有用户并签发正常浏览器 session；
它不会创建用户或 Team，且仍会拒绝 suspended 用户或没有 active membership 的用户。email 不存在或有重复匹配时
会 fail closed。Server 会在 `staging` 和 `prod` 环境拒绝这组配置。

`OPENTAG_ENV` 是 OpenTag 唯一的环境与发布 channel 选择器。`dev` 对应本地开发行为与 `opentag-dev` binary，
`staging` 对应 `open-tag-staging` / `opentag-staging`，`prod` 对应 `open-tag` / `opentag`。托管 Node.js 进程的
`NODE_ENV` 仍可设为 `production`，但它不负责选择 OpenTag package，也不决定产品安全行为。Server 启动时会记录
解析后的环境、public URL、package 和 binary，且绝不从 hostname 推断环境。

打开 `/` 可使用 Team 共享 App Shell。active member 使用同一套导航和 member-safe 只读投影，Team Admin 额外获得管理控件。
在 **Settings → Computers** 中点击 **Generate connection command** 会签发一个 15 分钟、仅可使用
一次的 code，并复制由 Server 生成的安装/login 命令。页面会轮询当前用户的 Computer 列表，直到新的 daemon
握手到达；Web 本身不会选择 npm package、binary 或 Server URL。membership 与邀请变更可使用 CLI；Team Admin
也可在 **Settings → Members** 创建、复制和轮换当前 bearer 邀请，成功兑换后 Web 会选中刚加入的 Team：

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

## Onboarding 端到端检查

`scripts/e2e/onboarding-e2e.mjs` 会在真实 Server、真实 PostgreSQL、真实 Web 构建产物和真实 Computer daemon 上
跑完整个 `/onboarding` 流程：浏览器登录、从页面读取连接命令、用 CLI 兑换、运行 `daemon service-run`、等待协商出的
Provider readiness 投影、在表单里创建 Agent，然后检查 handoff、ready、成员只读和运行时中断这几种状态。

```bash
pnpm build
npm install --no-save playwright-core   # 在 workspace 之外安装，或复用已有安装
OPENTAG_E2E_PLAYWRIGHT_PATH=/path/to/playwright-core node scripts/e2e/onboarding-e2e.mjs
```

该检查需要可访问的 PostgreSQL 超级用户地址和 Chromium 可执行文件。它会自行创建并删除数据库、监听独立端口，并把
截图、Server 与 daemon 日志、记录到的 console 条目写入 artifact 目录。由于每次运行都会删库，它会拒绝任何不是一望即知
可丢弃的 E2E 标识符的库名，并在 Server 停止后再次删除该库。端口被占用时它会直接拒绝启动，因此绝不会去驱动另一个本地
Server。daemon 拿到的是显式构造的 Provider 环境，而不是调用者的 shell 环境，因此在任何开发机上 readiness 都一致。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_E2E_ADMIN_DATABASE_URL` | `postgresql://opentag:opentag@127.0.0.1:5432/postgres` | 创建 E2E 数据库使用的超级用户地址 |
| `OPENTAG_E2E_DATABASE` | `opentag_e2e` | E2E 数据库名，每次运行都会删除并重建；必须是包含 `e2e` 的小写标识符 |
| `OPENTAG_E2E_PORT` | `8123` | 本次运行的 Server 监听端口 |
| `OPENTAG_E2E_CHROMIUM` | `/opt/pw-browsers/chromium` | Chromium 可执行文件 |
| `OPENTAG_E2E_PLAYWRIGHT_PATH` | `playwright-core` | `playwright-core` 的模块标识或路径 |
| `OPENTAG_E2E_ARTIFACTS` | `$TMPDIR/opentag-onboarding-e2e` | 截图与日志输出目录 |
| `OPENTAG_E2E_PROVIDER_STUB` | `on` | 设为 `off` 时改用 `PATH` 上已安装的 Claude Code CLI，而不是 stub |
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | stub 关闭时守护进程读取的 Claude Code 配置目录 |
| `OPENTAG_E2E_KEEP_DATABASE` | `off` | 设为 `on` 时运行结束后保留 E2E 数据库，便于排查 |

流程中有两部分无法离线执行。Provider readiness 使用一个 stub 可执行文件，它满足与 Claude Code CLI 相同的 probe
契约，因为 CI 中没有已登录的 Codex 或 Claude Code 安装。Feishu 授权需要访问 `open.feishu.cn`，因此该检查会真实发起一次
setup attempt 并记录结果，然后把一条已授权的 binding 写入数据库，用于确认 Server 会投影 handoff readiness、页面会据此
推导出 ready 状态。

## 环境变量

仅在需要本地覆盖时复制 `.env.example`。当前进程不会自动加载环境文件。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENTAG_HOST` | `127.0.0.1` | Server 监听地址 |
| `OPENTAG_PORT` | `8000` | Server 监听端口 |
| `OPENTAG_SERVER_URL` | `http://127.0.0.1:8000` | CLI doctor 目标地址 |
| `OPENTAG_PUBLIC_URL` | 无 | 浏览器 callback 和邀请链接使用的必需 Server 公共 origin |
| `OPENTAG_ENV` | `dev` | OpenTag 环境/channel：`dev`、`staging` 或 `prod`；托管值要求 HTTPS |
| `OPENTAG_DATABASE_URL` | 无 | 必需的 PostgreSQL 连接地址 |
| `OPENTAG_JWT_SECRET` | 无 | 必需的 access token 签名 secret，至少 32 个字符 |
| `OPENTAG_ENCRYPTION_KEY` | 无 | 必需的 canonical base64 编码 32-byte 应用层加密密钥 |
| `OPENTAG_GOOGLE_CLIENT_ID` | 无 | 可选 Google OIDC client id，必须与 secret 同时配置 |
| `OPENTAG_GOOGLE_CLIENT_SECRET` | 无 | 可选 Google OIDC client secret，必须与 client id 同时配置 |
| `OPENTAG_DEV_AUTH_BYPASS_ENABLED` | `false` | 显式启用仅限 loopback 的开发登录，必须同时配置 email |
| `OPENTAG_DEV_AUTH_EMAIL` | 无 | development bypass 选择的已有唯一 bootstrap 用户 |
| `OPENTAG_AUTO_MIGRATE` | `true` | 监听前执行已入库的 migration |
| `OPENTAG_OTEL_ENDPOINT` | 空 | 可选 OTLP/HTTP traces endpoint；参阅 [Server 可观测性](./docs/zh-CN/observability.md) |
| `OPENTAG_OTEL_HEADERS` | 空 | 逗号分隔 `key=value` 格式的 secret OTLP headers |
| `OPENTAG_OTEL_ENVIRONMENT` | `OPENTAG_ENV` | Trace deployment environment 标签 |
| `OPENTAG_OTEL_SAMPLE_RATE` | `1` | `0` 到 `1` 的全局 trace head sample rate |
| `OPENTAG_ACCESS_TOKEN_TTL_SECONDS` | `900` | access token 有效期 |
| `OPENTAG_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | refresh JWT 有效期 |
| `OPENTAG_HOME` | 随 channel 而定 | 按生命周期分层的 `config/`、`data/`、`state/`、`logs/` 根目录（源码默认为 `~/.opentag-dev`） |

如果 `doctor` 失败，其错误类别会区分配置、网络、HTTP 和无效响应。请确认 Server 已启动，且配置的 URL 指向其基础地址。

## 发布

发布只能由 GitHub Actions 和 npm trusted publishing 执行。禁止从维护者机器发布任一 channel，也禁止向仓库
添加长期 npm token。channel identity、发布 guard、package smoke 和恢复步骤请参阅
[docs/zh-CN/releasing.md](./docs/zh-CN/releasing.md)。
