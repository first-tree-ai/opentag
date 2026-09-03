# OpenTag Portable 发布指南

> Canonical source: [../portable-release.md](../portable-release.md)
> Last synced with: 2026-09-03

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
curl -fsSL https://storage.googleapis.com/opentag-release/releases/prod/install.sh | sh
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
app/                    bundle 后的 CLI、其 package manifest、LICENSE、README、THIRD_PARTY_NOTICES、
                        dependency-closure.json 与内嵌的 node_modules/ 依赖树
bin/<binName>           artifact 本地 shim，在 payload 激活之前使用
~~~

bundle 后的 CLI 的 Context Tree 集成会在运行时解析已安装的 `@first-tree-ai/context-tree` 包——通过 `createRequire`
读取其 `package.json`、执行其 bundle 后的 CLI，并读取其自带的 skills 与 templates——因此每个 payload 都会内嵌该包
及其完整的生产依赖闭包，作为物理的 `app/node_modules` 目录树。`app/dependency-closure.json`
记录精确的 direct pin 与每个内嵌包的 name 与 version。

## 自动升级

portable 是唯一拥有完整支持的自动升级的安装模式；npm-global 安装永远不会自我升级，只能使用手动的
`opentag upgrade` / `opentag upgrade --check` 命令。每个 channel 只有一个精确目标，没有灰度队列或 canary：Server
轮询该 channel 已发布的 `latest.json`，并通过 v2 heartbeat result（`runtime.channelTarget` capability——见
[runtime-protocol.md](./runtime-protocol.md)）把这个精确目标广播给已连接的 Client。

daemon 的 updater 遵循严格的契约：

- **精确目标身份，单调 precedence。** 只有 version 字符串完全一致才算已是当前目标，因此仅 SemVer build metadata
  不同的目标仍会安装。SemVer precedence 只用于拒绝更旧的目标；目标还必须属于 Client 自身 channel，且绝不会自动降级。
- **受保护工作优先。** 安装之前，updater 会无限期等待，直到 Session 模块报告没有受保护的工作——交接不会丢失或
  重复任何已接受的 Turn、待完成的 Turn 完成/报告托管，或已接受的 IM 投递。Session 模块为每一类工作项都设定了
  上限（Turn 预算、投递截止时间、带终态结果的报告重试），因此 updater 自己不再添加强制超时。读取零工作快照前会
  先关闭新工作准入；此前已经接受的投递继续排空，之后到达的投递则收到可重试的 busy 结果。
- **每个目标只尝试一次。** 任何安装工作开始之前，尝试就会被持久化记录。失败——包括被中断的尝试——会进入
  blocked 状态且绝不自动重试：updater 等待更新的目标或手动 `opentag upgrade`，从而避免重试与重启风暴。
- **复用现有布局。** 安装下载不可变的版本 manifest（绝不读取 channel 指针），校验已发布的 SHA-256，解压到全新的
  不可变版本目录，对新 runtime 做冒烟检查，重写稳定 shim，并通过一次原子切换移动 `current`——与 `install.sh`
  完全相同的机制。
- **服务刷新与交接。** 切换之后，updater 通过新安装的二进制运行 `daemon refresh-service`，让 supervisor 定义由
  即将运行的版本重写，且自身不触发任何重启。随后以便留的 supervisor 重启退出码 `75` 退出：systemd 将其映射为
  干净的强制重启（`SuccessExitStatus=0 75` + `RestartForceExitStatus=75`），launchd 通过
  `KeepAlive.SuccessfulExit=false` 重启。由于稳定 shim 的存在，重启后的服务运行新版本，而 OpenTag home、Account
  凭据、Computer connection、Agent 与 placement 全部保持不变。

当前版本、目标、updater 状态以及最近一次尝试及其失败原因都可以在 `opentag daemon status` 中查看。

## 已发布对象结构

~~~text
<prefix>/<channel>/latest.json                 可变 channel 指针
<prefix>/<channel>/install.sh                  可变 channel installer，已固定该 channel 与 base URL
<prefix>/<channel>/<version>/manifest.json     不可变 release metadata
<prefix>/<channel>/<version>/SHA256SUMS        不可变 checksum
<prefix>/<channel>/<version>/<package>-<version>-<platform>.tar.gz
~~~

默认 coordinate 是 `opentag-release` bucket 的 `releases` prefix，通过
`https://storage.googleapis.com/opentag-release/releases` 对外提供。

version prefix 下的一切都是不可变的，写入时带 create-only precondition（`--if-generation-match=0`）以及
`--content-md5` digest，因此 Cloud Storage 会同时拒绝静默覆盖和损坏的上传。只有 `latest.json` 与 `install.sh` 可变；
它们最后才写入，且 `latest.json` 带 generation precondition，使两个发布者不可能交错写入。

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

verifier 会检查已发布的 checksum、解压后的结构、metadata 与内嵌的依赖图（精确 direct pin、closure record、随包
assets，以及无 symlink/无 native 的布局）。当 artifact 目标平台就是宿主平台时，还会实际运行它：通过 shim 运行
OpenTag CLI，并在隔离 home 下运行内嵌的 Context Tree CLI（`--version`、`--help`、`list`）。
它还会对不存在的 managed name 执行 OpenTag 的 `context-tree connect`，验证真实的 runtime 解析路径，
但不连接 Tree、不持久化配置。

portable builder 会内嵌 `@first-tree-ai/context-tree` 以及 frozen install 为它解析出的每个生产依赖，形成确定性的
扁平 `app/node_modules` 目录树：每个包一个真实目录，无 symlink、无嵌套 `node_modules`、无 native addon。包内容
只从已安装的 store 拷贝——绝不联网拉取，也绝不执行 lifecycle script；Context Tree 自带的 `postinstall` 会随发布
内容一起携带但保持惰性，因为 OpenTag 直接调用打包好的 CLI。app manifest 只保留真实的 direct pin；builder（在
identity smoke 之前）与 artifact verifier（对每个平台）都会运行同一套图校验。

**Fail-closed 依赖形状。** `apps/cli` 只能声明 `@first-tree-ai/context-tree`，且必须是精确的 `x.y.z` pin。未知或
非精确的 direct pin、非空的 optional/peer dependency、带 `os`/`cpu` 约束的包、内嵌包（Context Tree 自身除外）上
的 lifecycle script、发布内容里的 symlink、native addon，以及同名包解析到不同的已安装根目录都会让构建失败。
这些依赖形状必须先获得明确的打包支持才能发布。

**CI gate。** staging 与 production 的每次 `CLI Pack Smoke` 都会用刚构建好的 release-channel CLI 组装真实的
portable app、校验其内嵌依赖图，并在临时 `HOME` 与最小环境下运行迁移后的 Context Tree CLI 和 OpenTag 的
runtime 解析探针（无 `NODE_PATH`、`NODE_OPTIONS` 或宿主凭证；`scripts/portable/smoke-portable-app.mjs`）。
该 gate 不需要下载 Node.js runtime，因此依赖回归会直接在普通 CI
失败，而不是拖到 release 阶段。

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
   `md5Hash` 与 `sha256` metadata 都一致。`md5Hash` 是必需项而非「有则检查」：三者之中只有它描述实际存储的字节，
   因此缺失即 fail closed。出于同样原因，parallel composite upload 被全程禁用——composite 对象不带 `md5Hash`。
3. 仅以 create-only 方式上传缺失的不可变对象，每次都附带 `--content-md5` digest。
4. 重新列举，并要求 version prefix 完整。
5. 通过**公网**端点：逐字节比对该 version 的 `manifest.json` 与 `SHA256SUMS`，然后完整下载每个 asset 并对
   manifest 中的 SHA-256 校验。
6. 从公网端点按精确 version 安装一次该 release，并检查其报告的版本号。这一步在发布主机上运行，因此只覆盖该平台。
7. 读取 channel 指针以及产生它的 generation。若 channel 已经指向更新的 version，就此停止：不可变对象已发布且可按
   精确 version 安装，指针保持不动。
8. 写入 `install.sh`，再以第 7 步的 generation 为前置条件写入 `latest.json`，并对两者校验。precondition 失败不算
   错误——第 7、8 步会针对新状态重试直到收敛。

第 5、6 步正是 release 无法对外宣称一个公网端点实际不提供的 version 的原因。`HEAD` 或单字节 range 请求只能证明该
URL 有响应；一个陈旧或路由错误的缓存对象会通过检查，而之后每个真正下载它的 installer 都会因 checksum 不符而拒绝。
检查所用的每个 URL 都来自本地 release metadata，而不是任何已经存在于远端的内容。

第 7 步让发布单调向前，第 8 步让发布单写者化。先写 `install.sh` 是因为它与 channel 绑定、与 version 无关，因此
两次写入之间失败时，留下的 installer 至少与指针一样新。

## Channel head

一个 release channel 有两个必须保持一致的 head：npm dist-tag 与 portable 的 `latest.json`。`npm publish --tag latest`
会不管当前指向什么，直接把 npm 的 head 移到本次发布的版本上；因此在较新 release 之后发布较旧 release，会把 npm 拉回
旧版本，而 portable 指针正确地不动，两者就会对外宣称不同的版本。所以两个 head 采用同一条规则——只在版本前进时推进，
共用 `scripts/release-versions.mjs` 中的同一个比较器。乱序的 release 依然会发布、依然可按精确 version 安装，只是发布
在 `superseded` 这个 npm dist-tag 下，并且不动 `latest.json`。

release job 按 channel 用 `queue: max` 串行化，它会以 FIFO 顺序保留每一个 pending run。默认的 `single` 会取消已经
pending 的那个 run，从而静默丢掉一个受保护的 release tag。但顺序本身仍不作为依赖：无论 run 以什么顺序被处理，单调
性保证都成立。

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
| `OPENTAG_PORTABLE_DOWNLOAD_BASE_URL` | 公网 base URL（默认 `https://storage.googleapis.com/opentag-release/releases`） |
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
- installer 只负责安装或升级 OpenTag。onboarding 命令随后运行 `opentag connect`：兑换一次性 Computer code，绑定其中
  明确指定的 Agent / Computer，并安装或重启 daemon service。Provider CLI 的检测与安装由活跃 daemon 负责，绝不属于
  `install.sh`。
- 任何已发布的 version 都可以用 `sh install.sh --version <version>` 直接安装，它读取该 version 的不可变 manifest，
  完全不查 channel 指针。回滚就是这样做的，release gate 也用同一条路径在对外宣称之前先安装一次。
- 已存在的 version 目录永不就地改写，因为 `current` 可能经由它解析。强制重装会落到一个新目录，`current` 原子地移到
  新目录之后，才删除被取代的那份——因此被中断的重装可能留下一个多余目录，但绝不会让 `current` 悬空。
