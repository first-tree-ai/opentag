# OpenTag 发布指南

> Canonical source: [../releasing.md](../releasing.md)
> Last synced with: 2026-08-19

OpenTag 以两个相互隔离的 npm package identity 发布一个自包含 CLI artifact：

| Channel | Package | Binary | Source trigger |
| --- | --- | --- | --- |
| Staging | `open-tag-staging` | `opentag-staging` | `main` 的 `CI` 成功，或在 `main` 上有意手动重跑 |
| Production | `open-tag` | `opentag` | 受保护的稳定 `vX.Y.Z` tag |

内部 `@opentag/client`、`@opentag/shared` 和 `@opentag/server` workspace 永久保持 private。Client 与 Shared
代码会 bundle 进 CLI tarball，pack 后的 manifest 不得暴露任何 `@opentag/*` runtime dependency。
`THIRD_PARTY_NOTICES` 从实际 bundle 进 CLI 的精确第三方 package 生成，并包含完整许可证正文。bundle dependency
发生变化后运行 `pnpm notices:write`；`pnpm check` 会拒绝过期 notices。

## 发布权限

GitHub Actions 是唯一 release authority。npm 通过具备 `id-token: write` 的 trusted publishing 发布；仓库
不得保存 npm access token，也不得提供 token fallback。请在 npm 为 staging package 配置以下精确字段：

- Provider：GitHub Actions
- Organization 或 owner：`first-tree-ai`
- Repository：`opentag`
- Workflow filename：`publish-npm-package.yml`
- Environment：不填写

source manifest 保持 `open-tag`、`private: true` 和稳定 base version。workflow 只在临时 checkout 中调用
`scripts/prepare-cli-release.mjs` 改写 identity。

## Staging

`main` CI 成功后，npm workflow 会计算 next patch 并发布：

~~~text
X.Y.(Z+1)-staging.<release_sequence>.<github_run_attempt>
~~~

第一个 prerelease 分量是由 registry 驱动的发布序号，不再使用 GitHub workflow run number。发布 job 会串行
执行，读取目标 release line 已发布的最大序号并加一；新的 release line 从序号 `1` 开始。同一 commit 重试时
复用已有坐标，旧 run 的 commit 如果已不是当前 `main`，则会在发布前失败。

发布前会查询 registry。不存在的坐标可以发布；已存在的坐标只有在 `gitHead` 与 release commit 相同时才作为
幂等成功。registry 查询失败、出现不支持的已发布版本、revision 已过期或坐标属于其他 commit 时都会硬失败。

如果首次运行因为 npm trusted publishing 未配置而失败，请先按上述字段配置 publisher，再从 `main` 手动
dispatch workflow；不要添加 token。发布后应核对 package metadata，并在空目录安装 registry 中的精确版本，
通过后才能把该 staging release 视为可用。

## Production

Production 发布有更严格的门槛：

- repository 必须为 public；
- tag 必须匹配 `vX.Y.Z`；
- tag version 必须等于 `apps/cli/package.json`；
- tagged commit 必须属于 `main`；
- version 必须不低于 `0.0.2` 且未存在于 npm；
- `v*` tag 必须通过受保护的 release-tag ruleset 创建。

同一个 tag 会发布 npm CLI 与 GHCR server image。image 带 full commit 和 SemVer tag；除非已有更高版本的
release 发布，否则它还会接管 `latest`。该 image 是该 commit 已构建出的那一个而非重新构建，并在
`/app/LICENSE` 携带 OpenTag 的 Apache-2.0 许可证。创建 production tag 是不可逆的发布动作，必须获得明确
release 决策；验证 workflow 不代表获得创建 tag 的授权。

## Contributor smoke

构建依赖和 source CLI，然后验证真实 tarball：

~~~bash
pnpm exec turbo run build --filter=open-tag...
SOURCE_NAME=$(node -p "require('./apps/cli/package.json').name")
SOURCE_VERSION=$(node -p "require('./apps/cli/package.json').version")
SOURCE_BINARY=$(node -p "Object.keys(require('./apps/cli/package.json').bin)[0]")
node scripts/cli-pack-smoke.mjs \
  --channel source \
  --name "$SOURCE_NAME" \
  --version "$SOURCE_VERSION" \
  --binary "$SOURCE_BINARY"
~~~

CI 还会从 source manifest 和 CI run identity 派生确定性的 next-patch staging coordinate，在隔离 checkout 中
改写、重新构建，并执行相同的 pack、空目录安装、version、help 和 doctor failure 检查。
