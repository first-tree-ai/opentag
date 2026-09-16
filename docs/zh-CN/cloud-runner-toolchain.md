# Cloud Runner 工具链

> Synced: 2026-09-16
>
> Canonical source: [../cloud-runner-toolchain.md](../cloud-runner-toolchain.md)

这是 OpenTag **Cloud Runner 镜像**：供 [E3 执行链路](./cloud-runner-execution.md) 以固定 digest
消费的 linux/amd64 Linux 环境。本文介绍镜像构建和本地工具链验收；原生 Cloud 链路见 E3 文档。

Runner 由 `@opentag/client` 拥有，并与 **CLI 发布坐标**共享版本（`apps/cli`，当前为 `0.0.5`）。私有
Client `0.0.0` 不是 Runner 版本。

## 镜像内容

`PATH` 上的二进制由 root 拥有；进程以非 root 的 `runner` 用户运行，并使用独立的 `HOME`、`/workspace`
和 `/tmp`：

| 命令 | 锁定 |
| --- | --- |
| `node` | `v24.19.0`（`scripts/portable/node-version.txt`），镜像按 digest 固定 |
| `pi` | `@earendil-works/pi-coding-agent@0.84.2`（锁定在 `scripts/runner/pi/`） |
| `context-tree` | 来自 `apps/cli` 的 `@first-tree-ai/context-tree@0.1.14`（不是第二份独立 pin） |
| `git` | 继承自按 digest 固定的 Node 镜像（`2.39.5`，构建期断言；不经 apt 下载） |
| `gh` | GitHub CLI `2.100.0`，校验和验证的 linux/amd64 release |
| `slack` / `lark-cli` | 已审阅的 Provider CLI catalog（Slack `4.7.0`，Lark `1.0.92`），带 skip-update 环境变量/参数 |

Slack/Lark 原生可执行文件在 root 拥有的内部目录 `/opt/opentag/tools/internal/` 中保留上游
basename；`/opt/opentag/tools/bin/` 面向用户的命令是托管 launcher，因此已审阅的 catalog
probe 模式与二进制真实输出一致。

Pi 通过 Client Pi adapter 的显式名单接收 skill（`--no-skills` 加每个选定目录的 `--skill`）：六个打包的
Context Tree skill，外加四个装配在 `/opt/opentag/skills/` 的源码自有工具 skill（`git`、
`gh`、`slack`、`lark-cli`），其指引绑定到已安装 CLI 的 help 与 catalog 锁定。不会拷贝宿主机
skill。真实验收通过专用的 Pi RPC `get_commands` 查询核对 Pi 实际加载的 skill（只看名字，
不看内容），并要求名单与这十项完全一致。

运行时凭证单独提供。真实验收只通过 `docker cp` 注入过滤后的 Pi 配置，凭证绝不作为 Docker build arg。

## 构建

构建入口是 `scripts/runner/cli.mjs`。它复用 `scripts/prepare-cli-release.mjs` 和现有
release-version 约定。staging 版本必须从外部传入；Runner 不会自行递增。

~~~bash
# 生产坐标（必须与 apps/cli 版本一致）
node scripts/runner/cli.mjs build --channel prod --version 0.0.5 --tag opentag-runner:0.0.5

# 由现有发布流程解析出的 staging 坐标，再传入
node scripts/runner/cli.mjs build --channel staging --version 0.0.6-staging.4.1 --tag opentag-runner:staging

# 开发构建；dirty 树必须显式加开关。最终仍必须能做 clean build。
node scripts/runner/cli.mjs build --channel dev --allow-dirty true --tag opentag-runner:local
~~~

暂存器只拷贝 allowlist（不含 `.git`、`.env`、`.npmrc`、HOME、测试或工作数据），拒绝任何 symlink，
拒绝即使位于允许目录下的凭证文件名（如 `auth.json`），并且只暂存 **Git 跟踪的文件**
（`git ls-files`，因此 index 中的 intent-to-add 也算在内）：被忽略或未跟踪的本地文件（日志、
编辑器临时内容）绝不进入 context 或最终技能目录；无法确立源码 Git 归属时暂存直接失败。
因此新的预期源码文件需要 index 意图；dirty 开发构建仍携带已跟踪文件的工作区内容。Docker
context 是这份暂存目录，不是整个 checkout。frozen `pnpm install` 必须发生在 staging/prod 的
`prepare-cli-release` 改写之前，以免 lockfile 失配。

Node 版本必须在 `scripts/runner/pins.mjs` 中对应已审阅的镜像摘要；缺少映射的版本升级会在构建前失败。
运行时依赖冲突支持一层嵌套；若已嵌套包还需要再次嵌套冲突依赖，会明确失败，避免交付错误版本。
闭包在拷贝前校验完整规划布局——每个顶层与嵌套放置位置的每条依赖边——对任何无法精确表达的内容
（包括任意放置位置的同名遮蔽）一律拒绝装配。

镜像 label 记录 source SHA、dirty 标记、CLI/version 和 tool lock。构建成功后用 `docker inspect`
读取 image ID。

Cloud Run 要求 **linux/amd64**。Dockerfile 与 harness 始终传递 `--platform linux/amd64`。参见
[Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)。

## 复现 / 验收

专用 CI（`.github/workflows/runner-toolchain.yml`）构建同一份 linux/amd64 镜像并只跑 **offline**
smoke，离线容器使用 `--network none`。它从不发布，也不要求模型凭证。

~~~bash
node scripts/e2e/cloud-computer.mjs runner-toolchain --channel dev --mode offline --tag opentag-runner:worker-dev --allow-dirty true
# 复用已构建镜像：
node scripts/e2e/cloud-computer.mjs runner-toolchain --image opentag-runner:worker-dev --mode offline
# 真实模型验收（父任务私下注入隔离的 Pi 配置）：
node scripts/e2e/cloud-computer.mjs runner-toolchain --image opentag-runner:worker-dev --mode real --pi-config-dir /path/to/pi-config --provider deepseek
~~~

harness 始终使用 `--cpus=1 --memory=1g --memory-swap=1g`，并断言 inspect 值。offline 检查以
锚定整行模式解析 Node/Git/gh/Slack/Lark/Pi/CT/CLI 的精确版本（包括已审阅 catalog 的版本输出），并在一次性 tree
上组装六个 Context Tree skill。未知参数会失败。`--mode real` 必须同时提供 `--pi-config-dir`
和 `--provider`；缺少配置会在声称模型结果之前失败，非当前支持的 `deepseek` 以外的 provider
在参数解析时即被拒绝。只有 offline 模式报告 `model=skipped`。real 模式在宿主机侧先校验配置
（白名单常规文件、选定 provider 的文档、安全 settings 键、拒绝整个 HOME、symlink 与 `!`
shell 命令间接寻址），生成过滤后的暂存副本，并只把该副本通过 `docker cp` 加一次性 root
`chown`/`chmod` 注入全新 guard 容器——绝不整体挂载 `HOME`。`models.json` 只由受认可的顶层字段
`models` 与 `providers` 重建，未知字段绝不进入容器；畸形结构以固定消息失败。
guard 容器以 Docker `--init` 运行，由 PID 1 回收孤儿子进程，并以
`sleep infinity` 保活，直到 harness 清理时删除。镜像入口使用源码自有的 `opentag-init` 转发信号、
回收孤儿进程；offline 验收会在不使用 Docker `--init` 的条件下验证它。真实验收命令单独设置 30 分钟超时。
验收断言一个存活 Bash fixture 子进程被确认取消（共享的 Pi PID 跟踪集），随后删除
容器并以 daemon 确认删除结果。

计时字段是分开的：`startupMs` 量度全新容器加 Runner CLI 启动（`identity`）；probe/skills/
accept 的耗时单独报告（`durations`、`acceptanceMs`）。`memory.peak` 在容器退出前于容器内读
取，绝不在删除后读取。Runner CLI 在 `opentag-init` 下安装 SIGTERM/SIGINT 处理器，执行自身
清理后以 143/130 退出；宿主机 harness 在收到信号时先终止自有进程组（包括 Docker CLI 的子进程），再删除容器。
配置 JSON 解析失败只报告文件名（绝不回显源码片段）；验收日志脱敏除结构化字段与已知密钥前缀外，
还覆盖引号包围的 JSON 秘密字段和完整的 `Authorization`/`Bearer` 值。

默认不带子命令运行 `opentag-runner` 会非零退出，不会挂起等待 server。

## 拆除

Node harness 会登记临时目录和容器，并在成功、失败、`SIGINT`、`SIGTERM` 时删除它们。没有
keep-secrets 选项。

~~~bash
docker rm -f <container>
docker rmi -f opentag-runner:local
~~~

## E3 消费

E3 应钉住一次 **构建得到的 image ID**（构建后由 `docker image inspect` 报告的本地
`sha256:…`），并同时钉住 `/opt/opentag/identity.json` 里记录的同一 CLI 发布版本和
source SHA。本地 image ID 不是 registry digest：镜像推送之后，远端消费应钉 registry 的内
容 digest。不要把 `latest` 当作坐标。不要把本地 Docker 运行当成 native Cloud Run、
Sandbox、网络策略或 IM 的证明。

镜像大小、启动延迟、`memory.peak` 等验收测量应单独记录，等父任务提供数据后再写入。

## 边界

- 非 amd64 宿主机上的本地 Docker 走模拟，不能证明 native Sandbox 或 Cloud Run。
- E3 的 `serve` 命令主动连接经过认证的 Server Runner WebSocket；父容器不开放 HTTP 控制端口。
  参见[执行配置](./cloud-runner-execution.md)。
- 镜像里的 Slack/Lark 是 catalog 锁定、已关闭更新检查的 CLI，不是已登录的 IM。
