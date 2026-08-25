# OpenTag Portable 发布指南

> Canonical source: [../portable-release.md](../portable-release.md)
> Last synced with: 2026-08-25

Portable release 是一份自包含的 OpenTag 安装包：每个平台一个 tarball，同时携带 bundle 后的 CLI **和它自己的
Node.js runtime**，因此没有 Node.js、没有 npm、没有任何 package manager 的机器也能安装并运行 OpenTag。它发布到
Google Cloud Storage，用一条 `curl … | sh` 命令安装。

Portable channel 与 npm channel 完全一致。每个 portable release 都来自与其对应 npm package 相同的 commit、相同的
identity 改写和相同的 version coordinate，coordinate 的推导方式见 [releasing.md](./releasing.md)。

| Channel | Package | Binary | 安装根目录 |
| --- | --- | --- | --- |
| Staging | `open-tag-staging` | `opentag-staging` | `~/.local/share/opentag/staging` |
| Production | `open-tag` | `opentag` | `~/.local/share/opentag/prod` |

## 安装

~~~bash
curl -fsSL https://download.opentag.build/releases/prod/install.sh | sh
~~~

installer 会解析 channel 的 `latest.json`，下载所检测平台对应的 tarball，校验其已发布的 SHA-256，解压，运行一次新
runtime，然后才激活它。可用选项：

| 选项 | 作用 |
| --- | --- |
| `--version <version>` | 安装指定的不可变 version，而不是 `latest` |
| `--prefix <path>` | 安装根目录（默认 `~/.local/share/opentag/<channel>`） |
| `--bin-dir <path>` | shim 目录（默认 `~/.local/bin`） |
| `--force` | 即使目标 version 已经处于激活状态也重新安装 |
| `--no-path-edit` | 不修改 shell 启动文件 |
| `--path-mode auto\|prompt\|off` | installer 管理 `PATH` block 的方式 |

**重复安装代价极低。** 读取 `latest.json` 之后，installer 会检查请求的 version 是否已经是当前生效的安装：`current`
symlink 必须指向一份 `INSTALL.json` 与目标 version、platform、binary name 都一致的 payload，内嵌 runtime 与 app
entry 必须都存在，`--bin-dir` 中的稳定 shim 也必须已经经由 `current` 解析。全部满足时，installer 会提示 OpenTag
已是最新，并在不下载 payload 的情况下退出。半成品安装、被手工改过的 shim，或被删除的 `--bin-dir` 条目都无法通过该
检查，会以一次完整重装来修复。`--force` 则无条件重新安装。

## 目录结构

installer 会保留已安装过的每个 version，并用一个 symlink 在它们之间切换：

~~~text
<prefix>/versions/<version>/    解压后的 payload（激活后不可变）
<prefix>/current                指向生效 version 的 symlink，原子替换
<bin-dir>/<binName>             稳定 shim；每次运行都经由 `current` 解析
~~~

shim 是更新安全的关键。它从不写入某个 version 目录，因此 `daemon ensure-service` 写出的 daemon service 定义始终指向
shim，并能在之后每一次更新后继续生效。shim 会在 exec 内嵌 runtime 之前导出 `OPENTAG_INSTALL_MODE=portable`、
`OPENTAG_PORTABLE_ROOT` 和 `OPENTAG_PORTABLE_BIN_DIR`。

每个 payload 包含：

~~~text
VERSION                 纯文本 version
INSTALL.json            release metadata、platform、install mode 与 app entry
node/bin/node           内嵌 Node.js runtime，已对官方 SHASUMS256.txt 校验
app/                    bundle 后的 CLI、其 package manifest、LICENSE、README、THIRD_PARTY_NOTICES
bin/<binName>           artifact 本地 shim，在 payload 激活之前使用
~~~

bundle 后的 CLI 没有 `node_modules`：`apps/cli` 不声明任何 runtime dependency，一旦这一点发生变化，构建会 fail
closed，而不是产出一个只在用户运行时才崩溃的 artifact。

## 已发布对象结构

~~~text
<prefix>/<channel>/latest.json                 可变 channel 指针
<prefix>/<channel>/install.sh                  可变 channel installer，已固定该 channel 与 base URL
<prefix>/<channel>/<version>/manifest.json     不可变 release metadata
<prefix>/<channel>/<version>/SHA256SUMS        不可变 checksum
<prefix>/<channel>/<version>/<package>-<version>-<platform>.tar.gz
~~~

默认 coordinate 是 `opentag-release` bucket 的 `releases` prefix，通过
`https://download.opentag.build/releases` 对外提供。

version prefix 下的一切都是不可变的，写入时带 create-only precondition（`--if-generation-match=0`）以及
`--content-md5` digest，因此 Cloud Storage 会同时拒绝静默覆盖和损坏的上传。只有 `latest.json` 与 `install.sh` 可变，
并且最后才写入。

## 构建

~~~bash
# 先把 checkout 改写为目标 channel identity；portable 构建会校验它，
# 并拒绝发布过期或不匹配的 apps/cli/dist。
node scripts/prepare-cli-release.mjs --channel staging --version 0.0.2-staging.1.1
pnpm --dir apps/cli build

./scripts/portable/build-release.sh \
  --channel staging \
  --version 0.0.2-staging.1.1 \
  --skip-workspace-build \
  --platform "$(node -p 'process.platform + "-" + process.arch')"
~~~

artifact 输出到 `.portable-release/<channel>/`。发布前先验证：

~~~bash
node scripts/portable/verify-portable-artifact.mjs \
  --manifest .portable-release/staging/0.0.2-staging.1.1/manifest.json \
  --platform darwin-arm64 \
  --tarball .portable-release/staging/0.0.2-staging.1.1/open-tag-staging-0.0.2-staging.1.1-darwin-arm64.tar.gz
~~~

verifier 会检查已发布的 checksum、解压后的结构与 metadata；当 artifact 目标平台就是宿主平台时，还会实际运行它。

内嵌 Node.js version 固定在 `scripts/portable/node-version.txt`，必须是精确的 `vX.Y.Z`。其 tarball 在成为 artifact
的一部分之前，会先对该 release 的官方 `SHASUMS256.txt` 校验。

对给定 commit、version 与 platform，tarball 是字节可复现的：archive 时间戳统一为 release timestamp，条目排序固定，
owner identity 置零，gzip 不记录 mtime。因此 release 重试会重新上传完全相同的字节，而不会与 create-only
precondition 冲突。可复现性以 tar flavor 为界；release 构建在使用 GNU tar 的 Linux CI 上运行。

## 发布

~~~bash
./scripts/portable/release-gcs.sh --channel staging --version 0.0.2-staging.1.1 --skip-workspace-build
~~~

`release-gcs.sh` 会构建、上传，然后按用户的方式安装已发布的 release。上传步骤按固定顺序执行，每个阶段都是下一个
阶段的闸门：

1. 校验本地目录树，并检查每个 asset URL 与构建时使用的 download base URL 一致。
2. 列出远端 version prefix。出现意料之外的对象即判定 release 失败；已存在的对象必须与本地 artifact 的 size、
   `sha256` metadata 与 `md5Hash` 都一致。
3. 仅以 create-only 方式上传缺失的不可变对象。
4. 重新列举，并要求 version prefix 完整。
5. 通过**公网**端点获取该 version 的 `manifest.json` 与 `SHA256SUMS` 并逐字节比对，同时确认每个 tarball URL 可读。
6. 只有到这一步才写入 `latest.json` 与 `install.sh`，并同样进行校验。

第 5 步正是 release 无法对外宣称一个公网端点实际不提供的 version 的原因。它检查的每个 URL 都来自本地 release
metadata，而不是任何已经存在于远端的内容。

常用参数：`--dry-run` 只打印计划中的操作而不访问 Cloud Storage，`--preflight-only` 在不写入的情况下检查不可变
prefix 兼容性，`--skip-build` 复用输出目录中已有的 artifact。

## 发布权限

GitHub Actions 是 release authority。`publish-npm-package.yml` 会在 `npm publish` 之前对 portable release 做
preflight，使不可变 prefix 冲突在 release 仍可重试时就失败；随后再用同一批已 preflight 的 artifact 完成发布。若仓库
未配置 Cloud Storage，这些 portable 步骤会被跳过。

需要的 repository variable：

| Variable | 用途 |
| --- | --- |
| `OPENTAG_PORTABLE_GCP_WORKLOAD_IDENTITY_PROVIDER` | workload identity provider；同时是启用 portable 步骤的开关 |
| `OPENTAG_PORTABLE_GCP_SERVICE_ACCOUNT` | workflow 模拟的 service account |
| `OPENTAG_PORTABLE_GCS_BUCKET` | bucket 名称（默认 `opentag-release`） |
| `OPENTAG_PORTABLE_GCS_PREFIX` | channel 段之前的 object prefix（默认 `releases`） |
| `OPENTAG_PORTABLE_GCS_PROJECT` | 执行 `gcloud` 调用所用的 project |
| `OPENTAG_PORTABLE_DOWNLOAD_BASE_URL` | 公网 base URL（默认 `https://download.opentag.build/releases`） |
| `OPENTAG_PORTABLE_PLATFORMS` | 可选的构建平台过滤 |

发布使用 workload identity federation，因此仓库中不保存任何 service-account key。该 service account 需要 bucket 上的
`roles/storage.objectUser`：读取、创建与列举覆盖不可变对象，而 `storage.objects.delete` 也是必需的，因为 Cloud Storage
把覆盖 `latest.json` 与 `install.sh` 视为 replace。version prefix 的不可变性由 create-only 上传 precondition 保证，
而不是由 IAM 保证。若要在 IAM 层面同样强制，可以用限定在两个 channel 指针路径上的 IAM condition 授予
`roles/storage.objectUser`，其余路径只授予 `roles/storage.objectCreator` 与 `roles/storage.objectViewer`。

workload identity provider 必须带上把它固定到本仓库的 attribute condition。若不设置，任何地方的 GitHub Actions
workflow 都能为该 pool 换取 token 并冒充这个 release service account。

bucket 必须在 download base URL 上公开提供 release prefix。在此之前，上传仍会成功，但公网校验闸门会失败，channel
指针会被刻意保持原样。

## 运维说明

- installer 需要 `curl` 或 `wget`、`tar`，以及 `sha256sum` 或 `shasum`。支持 x64 与 arm64 上的 Linux 和 macOS；不支持
  Windows。
- 激活之后 installer 会运行 `daemon ensure-service`。exit code 3 表示 CLI 把 service 安装推迟到 `login` 创建
  credential 之后，这是首次安装的正常路径，不是失败。
- release 从不删除旧的 version 目录，因此可以用 `sh install.sh --version <older-version>` 回滚安装。
