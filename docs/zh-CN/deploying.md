# OpenTag 部署指南

> Canonical source: [../deploying.md](../deploying.md)
> Last synced with: 2026-09-20

OpenTag 的 Staging 环境运行在 [CapRover](https://caprover.com/) 上。每个合入 `main` 且通过 CI、完成 CLI/Runner 发布的 revision，都会用
`Docker` workflow 已经发布到 GHCR 的容器镜像自动部署。CapRover 主机上不构建任何内容，也不上传源码 tarball；一次部署
只是把指针切到一个不可变镜像。

| Environment | 触发条件 | 镜像 | Workflow |
| --- | --- | --- | --- |
| Staging | `main` 的 CLI/Runner 发布成功，或有意的手动运行 | `ghcr.io/first-tree-ai/opentag:<commit-sha>` | `deploy-staging.yml` |

Production Server 沿用现有运维部署流程。手动 **Deploy Runner** workflow 在兼容 Server 就绪后启用已发布的 Runner，
见 [Cloud Runner 发布](./cloud-runner-release.md)。

## 一次推送如何到达 Staging

1. 一个 revision 合入 `main`，`CI` 与 `Docker` 并行启动。
2. `Docker` 构建并推送不可变的 commit coordinate `ghcr.io/first-tree-ai/opentag:<commit-sha>`。
3. `CI` 成功，触发 CLI/Runner 发布；发布成功后触发 `Deploy Staging`。
4. `Deploy Staging` 先证明该 revision 属于 `main` 历史，等待 commit coordinate 发布完成，再确认该 revision 仍是 `main`
   的 tip。
5. CapRover App 被指向这个精确的镜像 tag，由 CapRover 拉取并完成上线。
6. 匹配的 Server 就绪后，启用已验证的 Runner 镜像和版本，再验证实际响应的 Server 已加载目标配置。
   已就绪的 Instance 保留原有兼容镜像，直到正常回收。

部署始终使用按 commit 的 tag，绝不使用 `edge` 或 `latest`。移动的 tag 会让 CapRover 面对一个没有变化的镜像引用，从而
无法向前推进，也会让线上运行的 revision 无法识别。

排查"部署没发生"之前，有两个特性需要先知道：

- **Staging 绝不回退。** 连续 commit 的运行可能重叠，因此自动运行如果发现自己的 revision 已不是 `main` 的 tip，就会
  跳过，而不是覆盖更新的 revision。该运行仍然成功，并在 job summary 中记录这次跳过。
- **tip 损坏会让 Staging 停在原地。** 如果 commit `A` 通过 CI，随后 commit `B` 合入并失败，那么 `A` 的运行会因为 `A`
  不再是 tip 而跳过，`B` 也不会部署，Staging 保持在上一次成功上线的 revision。此时用手动运行有意部署 `A`。

## 仓库 Secrets

在 **Settings → Secrets and variables → Actions** 中配置以下 repository secrets。Workflow 会在调用 CapRover 之前列出
缺失的名称并失败，因此未配置的部署会被明确报告，而不是执行到一半。

| Secret | 值 | 获取位置 |
| --- | --- | --- |
| `CAPROVER_STAGING_SERVER` | CapRover dashboard URL，例如 `https://captain.apps.example.com` | 你的 CapRover 实例 |
| `CAPROVER_STAGING_APP` | 承载 Staging 的 CapRover App 名称 | CapRover dashboard → Apps |
| `CAPROVER_STAGING_APP_TOKEN` | App 级别的部署 token | CapRover dashboard → App → Deployment → App Token |

请使用 App Token 而不是 CapRover 账号密码。该 token 只授权对这一个 App 的部署，泄露后无法重配置服务器其余部分，并且
可以在该 App 的 Deployment 页单独轮换，不影响其他 App。

Workflow 声明了 `staging` 这个 GitHub Environment，使部署出现在仓库的 Deployments 视图中，之后也可以为它加上保护规则。
Repository secrets 在该 job 中依然可读；把这三个 secret 改放到该 Environment 下同样可行，并能把它们限定在 Staging。

## CapRover App 前置条件

Workflow 只改变 App 运行哪个镜像。以下都是首次部署前必须在 CapRover 侧完成的配置。

- **Container HTTP port** 为 `8000`，与镜像暴露的端口一致。
- **PostgreSQL**：CapRover 的一键 Postgres App，或主机可达的外部实例。
- **持久化存储**：server 镜像本身不需要，但数据库 App 需要。

### 容器日志轮转

server 镜像不能控制 Docker 的 logging driver。首次部署前，请在所有可能运行 server 的 Swarm node 上配置 Docker
daemon，或设置等效的 CapRover logging 选项。Docker daemon 的具体配置入口是 `/etc/docker/daemon.json`：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

修改该文件后，按主机操作系统的要求重启或重新加载 Docker daemon。上面的 `max-size` 与 `max-file` 是 server 的预期
限制；Docker 不会从镜像 label 读取它们。本仓库 `docker-compose.yml` 中的 `logging:` block 只作用于本地 Postgres
service，不会配置 CapRover 的 server container。

- App 上的**环境变量**：

| 变量 | Staging 取值 |
| --- | --- |
| `OPENTAG_ENV` | `staging` |
| `OPENTAG_HOST` | `0.0.0.0` |
| `OPENTAG_PORT` | `8000` |
| `OPENTAG_PUBLIC_URL` | App 的 HTTPS URL；hosted environment 拒绝纯 HTTP |
| `OPENTAG_DATABASE_URL` | Staging 数据库的 `postgresql://…` |
| `BETTER_AUTH_SECRET` | 至少 32 个随机字符，Staging 专用；签发全部 Account session |
| `OPENTAG_JWT_SECRET` | 至少 32 个随机字符，Staging 专用，且与 `BETTER_AUTH_SECRET` 不同；仅用于签名 Slack OAuth state |
| `OPENTAG_ENCRYPTION_KEY` | Base64 编码的 32 字节 key，Staging 专用 |
| `OPENTAG_AUTO_MIGRATE` | `true`，使每次上线都应用待执行的 migration |
| `OPENTAG_PORTABLE_DOWNLOAD_BASE_URL` | 可选；默认 `https://dl.opentag.build/releases` |
| `OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS` | 可选；默认 `300000` |
| `GOOGLE_CLOUD_PROJECT` | 可选；将中继的 Web App 与 CLI 错误转发到 Google Cloud Error Reporting，参见 [客户端错误上报](./error-reporting.md) |

这两个可选变量控制 Server 如何获知它向已连接 Client 广播的 channel 精确最新目标（用于自动升级）：它轮询下载
base URL 下该 channel 已发布的 `latest.json`，并在任何故障期间继续广播最后一次已知的目标。dev channel 从不广播
目标。

设置 `OPENTAG_PUBLIC_URL` 之前，先在 App 上启用 HTTPS 并强制 HTTPS；在 hosted environment 中，public URL 不是 HTTPS
时 server 会拒绝启动。Staging 的 secret 不得与任何其他环境共用。

配置在 server 开始监听之前校验，因此新增的必需变量要**先**加到 App 上，再部署需要它的 revision。缺少变量时，
CapRover 会不断重启一个在启动阶段就退出的容器，而不是以降级状态提供服务。

镜像工作流会把 commit SHA 作为 `OPENTAG_WEB_VERSION` 构建参数传入，Web App 会把它写进中继的错误报告（参见
[客户端错误上报](./error-reporting.md)）。自行构建的镜像应以同样方式传入自己的发布标识，例如
`docker build --build-arg OPENTAG_WEB_VERSION=$(git rev-parse HEAD) .`，否则报告中只会带有占位的 manifest 版本。

GHCR package 是公开的，因此 CapRover 匿名拉取镜像即可。如果该 package 之后被改为私有，需要在
**CapRover → Cluster → Docker Registries** 中用带 `read:packages` 的 GitHub token 添加 registry 凭据，否则每次部署都会
在拉取阶段失败。

## Agent Skills 对象存储

Agent Skills 以「每个 Skill 一个 `tar.gz` 对象」的形式存放在兼容 S3 的对象存储中。该存储是可选的：
未配置下面这组变量时，Skill 的列表、启用、禁用与删除仍然可用，但所有 bundle 的上传与下载都会以
`SKILL_STORAGE_UNAVAILABLE` 失败，界面会禁用这些操作，而不是给出一个无效按钮。五个必需值必须一起配置，缺一不可，
否则服务器会拒绝启动。

| 变量 | 取值 |
| --- | --- |
| `OPENTAG_SKILL_STORAGE_ENDPOINT` | 兼容 S3 服务的 HTTP(S) origin，不含凭据、query 或 fragment |
| `OPENTAG_SKILL_STORAGE_REGION` | 客户端签名使用的 region，例如 `us-east-1` |
| `OPENTAG_SKILL_STORAGE_BUCKET` | 存放 Skill 归档的 bucket，必须保持私有 |
| `OPENTAG_SKILL_STORAGE_ACCESS_KEY_ID` | 对该 bucket 有读写权限的 access key |
| `OPENTAG_SKILL_STORAGE_SECRET_ACCESS_KEY` | 该 access key 对应的 secret，永远不会写入日志 |
| `OPENTAG_SKILL_STORAGE_PREFIX` | 可选的对象键前缀，会被规范化（丢弃空斜杠段），默认 `skills`；空段或路径穿越段会在启动时被拒绝 |
| `OPENTAG_SKILL_STORAGE_FORCE_PATH_STYLE` | 可选，默认 `true`，MinIO 以及多个其他服务要求开启 |
| `OPENTAG_SKILL_STORAGE_GC_INTERVAL_SECONDS` | 可选，清理孤儿 Skill 对象的间隔秒数，默认 `3600`，设为 `0` 可关闭清理 |
| `OPENTAG_SKILL_STORAGE_GC_GRACE_SECONDS` | 可选，对象可被清理前的最小存活秒数，默认 `86400`，下限 `300` |

bundle 始终以调用方自己的凭据（Account session、Computer machine token 或 Session CLI proof）经服务器中转，
因此 bucket 无需 presigned URL 或公开访问，可以完全私有。对象键由服务器根据 Account、Agent、Skill 与内容哈希推导，
调用方无法指定路径。`docker-compose.yml` 会启动本地 MinIO，并通过一次性 init 容器创建 `opentag-skills` bucket；
`.env.example` 中被注释的配置块已指向该服务。

替换 Skill 时会写入新对象并保留旧对象，由后台清理器回收那些超过宽限期、且没有任何 Skill 行引用的对象。清理器
只会考虑恰好位于本部署自身规范化前缀之下的键，因此多个部署可以共用一个 bucket——包括使用嵌套前缀（如 `skills`
与 `skills/staging`）——彼此都不会清理对方的对象。`skills/` 与 `/skills` 等同于 `skills`：配置值只规范化一次，
写入与清理使用同一形式。两个 `GC_` 变量仅在配置了存储组时才有意义。

## 官网登录状态提示

当 `OPENTAG_PUBLIC_URL` 为 `https://app.opentag.build` 时，Server 提供
`GET /api/v1/auth/browser/session-status`，仅允许 `https://opentag.build` 和 `https://www.opentag.build` 访问。
这个携带浏览器凭据的 CORS 读取接口只返回 `{ "authenticated": true | false }`，不会返回 Account 资料或 token。
接口实时检查浏览器 session 和 Account 是否有效，不延长 session 有效期；响应使用 `no-store`。其他部署不注册
该接口，其他 API 路由保持原有的来源校验规则。

应先部署 Server 的支持，再部署官网的导航状态提示。检查不可用时，官网保留普通登录入口，进入应用后仍会校验 session。

## 手动部署与回滚

现在必须已有匹配的 CLI/Runner 发布产物。只回滚 Runner 时，使用 **Deploy Runner** 并指定当前兼容 Server 的 SHA，
见 [Cloud Runner 发布](./cloud-runner-release.md)。

在 Actions 页面基于 `main` 运行 **Deploy Staging** workflow。`revision` 输入留空表示部署当前 tip；填入 commit SHA 则
部署该 revision，这也是执行回滚的方式。手动运行被视为显式决策，永远不会因为"过期"被跳过，但该 revision 仍必须属于
`main` 历史，并且已经有发布好的镜像。

回滚只回退应用代码，不会回退更新的 revision 已经执行过的数据库 migration，因此跨越破坏性 migration 的回滚需要一份
有意为之的数据库方案。

## 验证一次部署

Job summary 会记录部署的 revision、镜像 tag 和镜像 digest。之后再从 CapRover 侧确认上线结果：

- App 的 Deployment 页显示新的镜像引用和成功的构建日志。
- `https://<app>/healthz` 返回成功。
- App 日志中出现预期 revision 的 migration 与监听日志。
