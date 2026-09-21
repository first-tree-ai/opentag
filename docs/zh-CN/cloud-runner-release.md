# Cloud Runner 发布

[English](../cloud-runner-release.md)
> Last synced with: 2026-09-21

Runner 使用 CLI 的发布版本。现有 npm 发布流程先从同一份干净源码构建 linux/amd64 Runner、运行离线验收、
发布到 Artifact Registry，再发布 npm 和 portable 产物。整次发布成功后，通过 GitHub Actions artifact 记录
已验证的镜像 digest、频道、版本和源码 SHA。版本 tag 不覆盖；重试只有验证已有镜像身份后才可复用。
`Runner Toolchain` 保持独立的 PR 离线构建检查。

## 发布配置

复用 portable 流程的 `OPENTAG_PORTABLE_GCP_WORKLOAD_IDENTITY_PROVIDER` 和
`OPENTAG_PORTABLE_GCP_SERVICE_ACCOUNT`，不提供服务账号密钥或 npm token 回退。配置以下仓库变量：

| 仓库变量 | 含义 |
| --- | --- |
| `OPENTAG_RUNNER_STAGING_IMAGE_REPOSITORY` | staging GAR 镜像路径，不带 tag 或 digest |
| `OPENTAG_RUNNER_PROD_IMAGE_REPOSITORY` | production GAR 镜像路径，不带 tag 或 digest |
| `CAPROVER_STAGING_PASSWORD_SECRET` | 已有 Secret Manager 凭证资源，格式为 `projects/.../secrets/.../versions/latest` |
| `CAPROVER_PROD_PASSWORD_SECRET` | production 对应的 Secret Manager 资源 |

现有发布服务账号只需目标镜像仓库上的 `roles/artifactregistry.writer`。
部署通过同一个 provider 使用**直接身份联邦**，不模拟发布服务账号。
将镜像仓库 reader 和对应 CapRover secret 的 `roles/secretmanager.secretAccessor` 授予精确的 GitHub Environment subject。
构造身份前，先读取仓库的 subject 配置：

```sh
gh api repos/first-tree-ai/opentag/actions/oidc/customization/sub
```

默认模板下，若 `use_immutable_subject: true`，须在返回的 `sub_claim_prefix` 后追加 `:environment:staging`
或 `:production`；该前缀包含组织和仓库的不可变 ID。旧的 `repo:first-tree-ai/opentag:environment:staging`
格式无法匹配这类令牌。若使用自定义模板，核验实际 `sub` 声明，不假定上述任一格式。
完整成员格式为 `principal://iam.googleapis.com/projects/<pool-project-number>/locations/global/workloadIdentityPools/<pool>/subject/<subject>`。
不向发布服务账号授予管理员 secret 访问权，也无需新建服务账号。

两个部署 Environment 都须限制为 main，生产还须在授予 secret 权限前配置审批人。发布身份继续限定在经过审查的 main／
受保护 tag 工作流。在合入、启用流程前配置权限和变量；缺少发布配置会在 npm 发布前失败。
参考 Google 的[部署流水线直接身份联邦说明](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)。

### 失败发布的恢复

若某次发布已占用版本 tag（Runner 镜像已 push）但在 npm 发布前失败，会留下一个孤儿镜像 tag。staging 版本号派生自
npm 已发布序列，因此后续每个提交都会重算出同一个版本号，流程在 tag 身份校验处失败而非覆盖它。恢复方式：先给被占用
的镜像加一个隔离（quarantine）tag，再在 Artifact Registry 中删除原版本号 tag，然后重跑（会从干净源码重建该版本）。
绝不用不同构建覆盖已有 tag。

CapRover App Token 继续负责部署 Server 镜像，但不能修改环境变量。Runner 启用步骤因此通过工作负载身份读取已有
管理员凭证，仅在内存中使用，只修改两个 Runner 目标配置，不往 GitHub Secrets 增加管理员密码。
staging 使用已有的 `CAPROVER_STAGING_SERVER`、`CAPROVER_STAGING_APP`、`CAPROVER_STAGING_APP_TOKEN` secrets。
production 启用使用 `CAPROVER_PROD_SERVER`、`CAPROVER_PROD_APP`；生产批准由 `production` GitHub Environment 控制。

## Staging 和 production

staging 部署在 `npm Publish` 成功后启动，读取该次运行的准确发布记录，验证 npm gitHead 和镜像身份。
先部署匹配的 Server，再一起更新 `OPENTAG_CLOUD_RUNNER_IMAGE` 和 `OPENTAG_CLOUD_RUNNER_VERSION`。
已被 main 新提交替代的自动部署仍跳过；Runner 发布不完整时，不能悄悄保留旧 Runner 却宣称新 Cloud 版本发布完成。

npm 接受发布后，包仍可能处于处理阶段。准确版本查询返回 E404 时进行有时限的等待；元数据无效、认证失败或
源码不匹配仍立即失败。Runner 启用还会先等待初始 CapRover 构建完成，再获取配置快照。`check` 与写入前的
最后一次构建状态／配置并发检查仍立即失败，配置写入不进行重试。

若启用流程在写入后的验证阶段失败，先对同一目标运行 **Deploy Runner** 的 `mode=check`，再决定是否重新写入。
响应或读取失败，不能证明配置写入没有成功。

正式 tag 同时发布正式 CLI 和 Runner。先通过现有生产流程部署兼容 Server，再从 main 运行 **Deploy Runner**：
选择 `channel=prod`、准确的已发布 `version`，以及已部署 Server 的完整 `server_revision`。
`mode=check` 只检查；`mode=apply` 启用并验证。该流程不部署或回滚 Server。
Runner 源码必须位于所选 Server 的 main 历史中；提交祖先关系证明来源，不保证任意破坏协议兼容的版本可共存。

部署验证读取实际响应进程的 `/readyz`：`x-opentag-revision` 表示镜像内置的 Server 源码 SHA，
`x-opentag-runner-target` 是所用镜像和版本的哈希。控制面接受更新不能替代此验证。
这些响应头不含凭证；没有内置 SHA 的本地构建不声称具备部署证明。
随后创建的实例仍需通过已有原生 Runner 就绪检查；HTTP 就绪不能证明真实 Cloud Run 分配，也不能证明滚动部署的所有副本已完成。

## 存量 Instance 和回滚

首次统一发布前，保留当前配置的镜像 digest 作为回滚基线。若手工发布的镜像没有 CLI 版本 tag，先核验镜像身份及 npm gitHead，再为同一个 digest 补上缺失的 tag；不重新构建，也不覆盖已有版本 tag。后续统一发布会自带这个坐标，常规回滚流程无需旧版回退分支。

目标版本只选择新建 Instance。此前已验证并就绪的 Instance，在持久化的物理身份相同、协议兼容，且云端确认资源自创建以来未被更新时，允许跨目标版本变更重连。
[Cloud Run](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.instances) 支持在 UID 不变时原地更新镜像，所以仅校验 UID 不够，这条路径还要求云端资源处于初始 generation。OpenTag 自身不原地更新 Instance 镜像。
首次准入仍严格校验目标镜像和版本。旧镜像不能借给其他 Session；已有工作继续执行，按现有保存、空闲回收流程退出，
下次分配从同一个 Session 存储地址恢复。

只回滚 Runner 时，用 **Deploy Runner** 选择旧的已发布版本，并填写**当前兼容的 Server 版本**。
staging 手动启用与自动部署共享并发组。事故期间需协调排队中及后续自动部署；未来成功的 main 发布仍可能推进目标版本。
该操作不会回退 CLI 频道 latest，也不会降级用户本地安装的 Client。

回滚验证后改变目标，不替换正在运行的 Instance。严重故障实例使用已有取消、保存、回收控制。
普通兼容的 Runner 升级或回滚无须全局排空，Instance 内也不进行原地下载或自更新。

只有 **Server** 回滚跨越不兼容协议时，才应先停止接收新工作，在兼容 Server 仍运行时完成结果确认和保存，再回收相关实例。
不能为了让部署显示成功而删除存在未确认执行记录的 Instance。镜像回滚不撤销数据库迁移、工作目录内容或外部操作。
故障实例可能只能恢复到最后一次已确认的工作目录保存点。
