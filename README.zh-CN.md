<div align="center">

<img src="https://opentag.build/assets/opentag-logo.png" alt="OpenTag" width="72">

# OpenTag

**在群里 @ 它一下，活就干了。**

OpenTag 是一个面向 Slack 和飞书的开源 AI 同事。在频道里 @ 它，真正的编码 Agent——Claude Code 或
Codex——会接下这条消息，在你自己的机器上开工，并回到同一个话题里回复你。用你的订阅、你的机器、你的代码。

[![CI](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml/badge.svg)](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/first-tree-ai/opentag?style=flat)](https://github.com/first-tree-ai/opentag/stargazers)
[![Node.js](https://img.shields.io/badge/node-22.13%20%7C%2024%20%7C%2026-5FA04E?style=flat&logo=node.js&logoColor=white)](#开发)

[官网](https://opentag.build/zh?utm_source=github&utm_medium=readme&utm_campaign=opentag-site) · [快速开始](#快速开始) · [文档](#文档) · [开发指南](./DEVELOPMENT.zh-CN.md) · [贡献指南](./CONTRIBUTING.zh-CN.md) · [安全策略](./SECURITY.zh-CN.md)

**[English](./README.md) | 简体中文**

</div>

> 权威来源：[README.md](./README.md)　·　同步日期：2026-09-02

```text
 #产品研发 ─────────────────────────────────────────────────────────────

  Priya  16:09
  @OpenTag 移动端的注册按钮点不动了，能看一下吗？

  OpenTag  BOT  16:09
  在看了。serena-mbp 上跑 Claude Code。                          👀

  OpenTag  BOT  16:24
  宽度小于 380px 时 CTA 被吸底栏盖住了。已修 z-index，推到
  fix/signup-cta-mobile，截图在话题里。要我开 PR 吗？

 ──────────────────────────────────────────────────────────────────────
```

> **Pre-alpha。** 控制面、本地 Runtime 以及飞书和 Slack 链路今天已经端到端跑通。安装与管理工作流仍在完善，
> 公开 API 在第一个稳定版本前仍可能变化。参见[项目状态](#项目状态)。

---

## OpenTag 是什么

你的团队已经在 Slack 或飞书里沟通，你也已经在为 Claude Code 或 Codex 付费。但 Agent 住在某台笔记本的终端
里：每个需求都要人工搬过去，每个结果都要人工搬回来，而让这个需求成立的上下文，留在了 Agent 永远看不到的
频道里。

OpenTag 把 Agent 放进房间。它是整个频道共用的一个机器人：有人 @ 它，OpenTag 就把这条消息路由给绑定在你所
enrollment 的机器上的 Agent，Agent 在那台机器上、用那台机器上已有的凭证开工，然后回到它被提问的那个话题里
回复。没有任何东西经由厂商代理——OpenTag 不附带模型，也不持有 provider 密钥。你运行的 Server 是控制面，活
在你自己的硬件上干。

---

## 把它放进房间。

*一个机器人，整个频道共用——不是和机器人私聊。*

- **[飞书与 Slack](#聊天平台) →** 把 Agent 绑定到工作区，邀请它进频道，然后 @ 它。
- **[Channel 与 Thread Session](./docs/zh-CN/thread-sessions.md) →** 每个频道保持一个长生命周期 Session；只有真实的话题事件到达时才物化 Thread Session，并带上有界的根消息上下文，Agent 不用猜。
- **[direct 与 ambient 注意力](./docs/zh-CN/thread-sessions.md) →** Agent 知道自己是被直接叫到，还是只是在旁听，并自行决定回复、开话题还是加 Reaction。
- **[用 provider 自己的 CLI 回复](./docs/zh-CN/direct-provider-cli.md) →** OpenTag 把受限的 IM 凭证交给 Agent，消息和 Reaction 出自 Agent 自己的判断，而不是模板化的机器人回复。

## 它跑在你自己的机器上。

*一台 Computer 就是一张工位。代码不离开它。*

- **Computer enrollment →** 在 Web 里生成 15 分钟有效的连接命令，粘贴到该干活的那台机器上执行。它会保存 enrollment 范围的凭证，并在 Linux 和 macOS 上安装当前用户的 daemon。
- **独立的机器身份 →** 机器凭证与账号登录彼此独立。登录永远不会启动 daemon；daemon 凭证也永远管不了你的账号。
- **统一的 Home 目录 →** 配置、运行时状态和 Agent 工作区都在 `${OPENTAG_HOME}` 下，默认私有（`0700` / `0600`）。[目录结构与恢复](./DEVELOPMENT.zh-CN.md)
- **daemon 生命周期 →** `daemon start`、`stop`、`restart`、`status`、`uninstall`，出问题时还有 `doctor`。

## 自带 Agent 和订阅。

*OpenTag 驱动你已经装好并登录的 CLI，它本身不附带模型。*

- **[Runtime](#runtime) →** OpenAI Codex 和 Claude Code，以那台机器上的 Agent CLI 形式被调用。
- **Runtime 配置 →** 在 Agent 的 **Runtime** 页签或 `agent update` 中设置 Codex Agent 的模型、reasoning effort 和单个 Turn 的最长时长。留空即把选择权交回 Codex；显式值由绑定的 Computer 校验，绝不被静默替换。
- **不托管密钥 →** OpenTag 从不索要 provider API key。Agent 依旧按它在那台机器上原有的方式认证。

## 为“不丢活”而造。

*会丢请求的 Agent，比没有 Agent 更糟。*

- **持久化 delivery custody →** 入站消息先持久化再显式移交托管，Turn 中途重启不会把请求悄悄吞掉。
- **恢复与 revision fencing →** Agent/Computer 绑定不可变并带 revision fencing，过期的 Runtime 无法认领已经易主的工作。
- **[Internal Session collaboration](./docs/zh-CN/internal-session-collaboration.md) →** Agent 之间可以持久化互发消息，带显式重试，而不是 best-effort 式的沉默。
- **真实的测试门禁 →** 除完整离线用例、PostgreSQL 集成测试、CLI tarball 安装和生产容器健康冒烟外，Agent Runtime 还有 CI 强制的 100% 覆盖率门禁。

## 全部可自托管。

*你的 Server、你的数据库、你的规则。*

- **Apache 2.0 →** 没有托管服务例外条款，也没有商用附加条件。[LICENSE](./LICENSE)
- **一个容器 →** `ghcr.io/first-tree-ai/opentag`，按 commit 发布。指向你自己的 PostgreSQL 即可。[部署指南](./docs/zh-CN/deploying.md)
- **同源 Web →** 管理界面由同一个 Server 提供，没有需要额外信任的第三方前端。
- **[可观测性](./docs/zh-CN/observability.md) →** OpenTelemetry trace 与 metric 发往你自己的 endpoint。

---

## 快速开始

目前 OpenTag 从源码 checkout 构建和运行，发布安装渠道仍在建设中，参见[项目状态](#项目状态)。

**前置要求：** Node.js 22.13+（22.x）、24.x 或 26.x · Corepack · pnpm 10.12.1 · Docker（用于本地 PostgreSQL）

**1. 启动 Server。**

```bash
corepack enable
pnpm install
docker compose up -d postgres

export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000

pnpm build
pnpm --filter @opentag/server start
```

Migration 在 Server 开始监听前执行，服务启动在 `http://127.0.0.1:8000`。

**2. 创建首个账号并安装 CLI。** 在另一个终端：

```bash
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_BOOTSTRAP_WORKSPACE_NAME=example
export OPENTAG_BOOTSTRAP_WORKSPACE_DISPLAY_NAME=Example
pnpm --filter @opentag/server bootstrap:admin

./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
opentag-dev login --server http://127.0.0.1:8000 -- <account-login-code>
```

把 `~/.local/bin` 放在 `PATH` 最前，daemon service 才会用当前 checkout 构建的 CLI 而不是旧 shim。若要在
loopback 下不配 Google 凭证开发，设置 `OPENTAG_DEV_AUTH_BYPASS_ENABLED=true` 和
`OPENTAG_DEV_AUTH_EMAIL` 为 bootstrap 邮箱；该 bypass 在 `dev` 环境之外会被拒绝，且永不创建账号。

**3. 连接一台 Computer。** 打开 `http://127.0.0.1:8000/` 登录，进入 **Agents** 区域生成 Computer 连接命令
（15 分钟有效），在该干活的机器上运行：

```bash
opentag-dev computer connect --server http://127.0.0.1:8000 -- <computer-connect-code>
opentag-dev computer list     # Computer 应显示为 online
```

该命令保存机器凭证，并安装或重启当前用户的 daemon。加 `--no-start` 则只保存凭证、不安装 service。

**4. 创建 Agent。**

```bash
opentag-dev agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
opentag-dev agent list
```

**5. 把它放进频道。** 在 Web 里把 Agent 绑定到飞书或 Slack，邀请机器人进频道，然后 @ 它。参见
[聊天平台](#聊天平台)。

完整本地流程、校验命令与恢复说明：**[DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)**。

---

## Runtime

OpenTag 不附带模型。它驱动 enrollment 机器上已安装并登录的 Agent CLI，所以换 provider 只是改 Agent 上的一个
字段，而不是一次迁移。

| Provider | CLI | Runtime 配置 |
| --- | --- | --- |
| OpenAI Codex | `codex` | 模型、reasoning effort、单 Turn 最长时长，由绑定的 Computer 校验 |
| Claude Code | `claude` | 已支持作为 Runtime；Effective Runtime Snapshot 尚未开放 |

## 聊天平台

| 平台 | 绑定方式 | 配置 |
| --- | --- | --- |
| 飞书 / Lark | 自建应用，在 Web 中 Agent 的 IM 配置流程里绑定 | 产品内完成 |
| Slack | OAuth 安装，外加指向 `OPENTAG_PUBLIC_URL` 的 events endpoint | [Slack App 配置](./docs/zh-CN/slack-app-setup.md) |

两个平台共用同一套路由：每个 Agent 和频道一个 Channel Session，Thread Session 按需物化，回复由 Agent 通过
provider 自己的 CLI 发出。

---

## 架构

```text
        Slack  ·  飞书 / Lark                浏览器（同源 Web）
                     │                              │
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐      ┌───────────────┐
                     │   OpenTag Server (Fastify)   │─────>│  PostgreSQL   │
                     │   REST · Better Auth · WS    │<─────│               │
                     └──────────────┬───────────────┘      └───────────────┘
                                    │  Runtime 协议走 WebSocket
                                    ▼
                     ┌──────────────────────────────┐
                     │   OpenTag daemon             │  你的笔记本或云主机
                     │   （当前用户的 service）      │  紧挨着你的代码
                     └──────────────┬───────────────┘
                                    │  spawn
                     ┌──────────────┴───────────────┐
                     │   codex  ·  claude           │  你的 CLI、你的订阅
                     └──────────────────────────────┘
```

| 层 | 技术栈 |
| --- | --- |
| Server | Fastify、Better Auth、PostgreSQL migration、Computer WebSocket endpoint |
| Web | React，由 Server 同源提供 |
| CLI | Commander；源码 checkout 下为 `opentag-dev`，安装渠道上线后为 `opentag` |
| Client / daemon | 负责 Computer enrollment 与执行 Agent Turn 的 TypeScript 运行时 |
| Shared | 各 workspace 共用的 Zod schema 与 HTTP path 契约 |

协议细节：[Runtime 协议](./docs/zh-CN/runtime-protocol.md)。

---

## 文档

| 我想…… | 从这里开始 |
| --- | --- |
| 在本地跑起来 | [快速开始](#快速开始) · [开发指南](./DEVELOPMENT.zh-CN.md) |
| 搞懂消息如何到达 Agent | [IM Channel 与 Thread Session](./docs/zh-CN/thread-sessions.md) · [Runtime 协议](./docs/zh-CN/runtime-protocol.md) |
| 让 Agent 自主回复和加 Reaction | [直连 provider CLI 消息](./docs/zh-CN/direct-provider-cli.md) |
| 接入 Slack | [Slack App 配置](./docs/zh-CN/slack-app-setup.md) |
| 让 Agent 之间互相沟通 | [Internal Session collaboration](./docs/zh-CN/internal-session-collaboration.md) |
| 部署到自己的基础设施 | [部署指南](./docs/zh-CN/deploying.md) · [可观测性](./docs/zh-CN/observability.md) |
| 发布或安装构建产物 | [发布指南](./docs/zh-CN/releasing.md) · [便携版发布指南](./docs/zh-CN/portable-release.md) |
| 参与贡献 | [贡献指南](./CONTRIBUTING.zh-CN.md) · [行为准则](./CODE_OF_CONDUCT.zh-CN.md) |
| 报告安全漏洞 | [安全策略](./SECURITY.zh-CN.md) |

---

## 开发

```bash
corepack enable
pnpm install
pnpm check && pnpm build && pnpm typecheck && pnpm test
```

`pnpm lint` 只做 lint 反馈，`pnpm format` 应用 Biome 格式化。Pull request 的必需检查是 `CI` 汇聚 job：除上述
命令外，还包括 source 与 staging CLI tarball 安装、生产容器健康冒烟，以及各受支持的 Node.js 版本线。Agent
Runtime 另有自己的 100% 覆盖率门禁。

请先阅读[贡献指南](./CONTRIBUTING.zh-CN.md)；完整本地流程见 [DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)。

---

## 项目状态

OpenTag 以小而经过验证的纵向切片推进，`main` 变动很快。

**今天已经可用：** 控制面与同源 Web；基于 Better Auth 的账号登录；独立认证的 Computer enrollment、在线状态
以及 Linux/macOS 上的当前用户 daemon；带不可变 Computer/provider 绑定与 revision fencing 的 Agent Registry；
带 delivery custody、上报与恢复的持久化 Agent Runtime 执行；飞书与 Slack 入站标准化及 Channel/Thread Session
路由；供 Agent 自主回复和 Reaction 的 provider CLI 凭证交接；Internal Session collaboration；以及 `doctor`、
`login`、`agent`、`computer`、`session` 和 `daemon` 命令。

**还没有：** 公开的安装渠道——[releasing.md](./docs/zh-CN/releasing.md) 与
[portable-release.md](./docs/zh-CN/portable-release.md) 中描述的 npm 与便携版 `curl … | sh` 链路已经构建完成，
但尚未对外提供正式发布，目前请从源码 checkout 构建。Windows daemon service 不在 v0.1 范围内。Web 中的 Tasks、
Skills 和 Integrations 区域是基于 demo 数据的界面预览，不是可用功能。OpenTag 没有托管版本，Server 由你自己运行。

数据库仍会创建一个内部默认 Workspace 和 grant 作为兼容层。OpenTag 不暴露任何 Workspace、Admin 或邀请管理界面，
既定的产品形态是 **Account → Computer enrollment → Agent → IM 绑定**。在该兼容层移除之前，历史遗留的活跃
grant 可能让多个 Account 管理同一批 Agent；它们不是共享协作容器。

---

## 为什么叫 OpenTag

因为整个产品就是一个动作。你早就知道怎么在群里请同事帮忙：打一个 `@`，加上他的名字。OpenTag 让这个动作能够
到达一个编码 Agent——并且保持它是开放的：Agent 由你选、机器归你有、许可证不会反悔。

---

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。
