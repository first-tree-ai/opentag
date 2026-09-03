<div align="center">

<img src="https://opentag.build/assets/opentag-logo.png" alt="OpenTag" width="72">

# OpenTag

**Claude Tag 的开源替代品。**

AI worker，就在你的 Slack 和飞书。在话题里 @ 它一下，活就干了：用你已经在付费的编码 agent 和模型
套餐，工作区以纯文本文件的形式留在你自己的机器上。免费，Apache 2.0：tag 归你、文件归你、套餐用你自己的。
它跑在你的机器上。

[![CI](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml/badge.svg)](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/first-tree-ai/opentag?style=flat)](https://github.com/first-tree-ai/opentag/stargazers)
[![Node.js](https://img.shields.io/badge/node-22.22%20%7C%2024%20%7C%2026-5FA04E?style=flat&logo=node.js&logoColor=white)](#参与贡献)

[官网](https://opentag.build/zh?utm_source=github&utm_medium=readme&utm_campaign=opentag-site) · [快速开始](#快速开始) · [文档](#文档) · [贡献指南](./CONTRIBUTING.zh-CN.md) · [安全策略](./SECURITY.zh-CN.md)

**[English](./README.md) | 简体中文**

</div>

> 权威来源：[README.md](./README.md)　·　同步日期：2026-09-02

<p align="center">
  <img src="docs/assets/opentag-walkthrough.svg" alt="OpenTag 的四个步骤：自带订阅、团队群里的 AI worker、从根消息读起的话题上下文，以及使用那台机器上已经配置好的工具。" width="100%">
</p>

---

## OpenTag 是什么

你已经在为 Claude Code 或 Codex 付费，但 Agent 住在某一个人笔记本的终端里。OpenTag 把它放进房间：
整个频道共用的一个机器人，跑在你自己的机器上。

- **[飞书与 Slack](#聊天平台) →** 绑定 Agent，邀请它进频道，然后 @ 它。
- **[Channel 与 Thread Session](./docs/zh-CN/thread-sessions.md) →** 每个频道一个长生命周期 Session；话题按需获得自己的 Session。
- **[以它自己的身份回复](./docs/zh-CN/direct-provider-cli.md) →** Agent 持有受限的 IM 凭证，自行决定回复、开话题还是加 Reaction。
- **不丢活 →** 消息先持久化再显式移交托管；Agent 绑定带 revision fencing。

---

## 打得开的上下文。

*它就存在你机器上的文件里，而不是一个需要你申请才能看的存储。*

- **来自它所在的每个频道 →** [Thread Session](./docs/zh-CN/thread-sessions.md) 带上有界的根消息与话题历史，Agent 从大家真正说过的话开始。
- **就是纯文本文件 →** 工作区和运行时状态都在 `${OPENTAG_HOME}` 下，默认私有。OpenTag 不会把这些文件上传到任何地方。
- **[Agent 之间互相沟通](./docs/zh-CN/internal-session-collaboration.md) →** 持久化的 internal Session，带显式重试。

## 它用那台机器上已有的工具干活。

*没有 OpenTag connector 要配置，因为中间就没有一层 OpenTag connector。*

- **它的 runtime 能调用什么，它就能用什么 →** 只要一个工具在那台 Computer 上装好、登录过、并且对所选 provider runtime 可见，Agent 就能在话题里用它，权限仍由那个工具自己说了算。OpenTag 不替它去发现或暴露工具。
- **不托管任何凭证 →** OpenTag 从不索要 provider API key。这些 CLI 按你自己运行它们时一模一样的方式，向它们各自的 provider 认证。

## 整套都归你。

*tag 归你、上下文归你、套餐用你自己的。*

- **模型不锁定 →** [Codex 和 Claude Code](#runtime) 以你机器上已登录的 CLI 形式运行。OpenTag 不附带模型，也从不索要 provider 密钥。
- **工作区文件留在本地 →** 工作区和运行时状态都在你控制的硬件上，而不是一个可能把你锁在门外的厂商账号里。至于 Agent 往它的 provider 发了什么、provider 又留存多久，那是你和 provider 之间的事。
- **tag 归你 →** Apache 2.0，没有托管服务例外条款，也没有商用附加条件。[LICENSE](./LICENSE)
- **哪里都能跑 →** `ghcr.io/first-tree-ai/opentag`，按 commit 发布，指向你自己的 PostgreSQL。[部署指南](./docs/zh-CN/deploying.md)

---

## 快速开始

唯一的前置条件：要跑 Agent 的那台机器上装好并登录了一个 [Agent CLI](#runtime)，`codex` 或 `claude`。
OpenTag 驱动它们，但不附带它们。

```bash
git clone https://github.com/first-tree-ai/opentag.git && cd opentag
pnpm install && ./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
```

需要 Node.js 22.22.2 及以上的 22.x、24.15.0+ 或 26.x，外加 Corepack 和 pnpm 10.12.1。
`dev-install.sh` 会把 `opentag-dev` 链接到 `~/.local/bin`，记得在 shell 配置里也把这个目录放在 `PATH` 最前。
已发布的安装渠道见[项目状态](#项目状态)。

<details>
<summary><b>运行 Server</b></summary>

<br/>

```bash
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin

pnpm build
pnpm --filter @opentag/server bootstrap:admin   # 执行 migration、创建首个 Account、输出它的登录 code
pnpm --filter @opentag/server start             # 前台运行，让它一直开着
```

bootstrap 自己会对空库执行 migration，所以要在 Server 占住终端之前先跑它。要部署到你自己的基础设施，见[部署指南](./docs/zh-CN/deploying.md)。

</details>

---

## 五分钟跑通第一个 Agent

**1. 登录。** `opentag-dev login --server <你的-server> -- <账号登录-code>`，然后在同一个地址打开 Web。

**2. 连接一台 Computer。** *Computer* 就是 Agent 可以干活的任意机器：你的笔记本，或一台云主机。在 Web 的
**Agents** 区域生成连接命令，在那台机器上运行：

```bash
opentag-dev computer connect --server <你的-server> -- <Computer-连接-code>
opentag-dev computer list     # Computer 应显示为 online
```

它会保存连接范围的机器凭证，并在 Linux 和 macOS 上安装当前用户的 daemon。

**3. 创建 Agent。**

```bash
opentag-dev agent create --name code-reviewer --display-name "Code Reviewer" --provider codex
```

**4. 把它放进频道。** 在 Web 里把 Agent 绑定到飞书或 Slack，邀请机器人进群，然后 @ 它。

完整流程：[DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md) · [聊天平台](#聊天平台)

---

## Runtime

OpenTag 不附带模型。它驱动已连接机器上已安装并登录的 Agent CLI，所以换 provider 只是改 Agent 上的一个
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
| Client / daemon | 负责连接 Computer 与执行 Agent Turn 的 TypeScript 运行时 |
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
| 跟进 Agent 正在做的工作 | [Tasks](./docs/tasks.md) |
| 报告安全漏洞 | [安全策略](./SECURITY.zh-CN.md) · [商标](./TRADEMARKS.zh-CN.md) |

---

## 项目状态

OpenTag 处于 pre-alpha。控制面、本地 Computer 连接与 daemon、Agent Runtime、持久化 IM 投递、飞书与
Slack 入站路由、Channel/Thread Session，以及直连 provider CLI 的凭证交接都已实现。公开 API 与包边界在第一个
稳定版本前仍可能变化。

还没有：[releasing.md](./docs/zh-CN/releasing.md) 与 [portable-release.md](./docs/zh-CN/portable-release.md)
中描述的 npm 与便携版安装渠道已经构建完成，但尚未对外提供，目前请从源码 checkout 构建。Windows daemon
service 不在 v0.1 范围内。Web 中的 Skills 和 Integrations 区域是基于 demo 数据的界面预览。OpenTag 没有托管
版本，Server 由你自己运行。

---

## 参与贡献

OpenTag 以小而经过验证的纵向切片推进，`main` 变动很快，记得常拉取。

```bash
pnpm install
pnpm check && pnpm build && pnpm typecheck && pnpm test
```

这就是 pull request 的必需检查（`CI` 汇聚 job），只少了它同时运行的 CLI tarball 安装和容器冒烟。
Agent Runtime 另有自己的 100% 覆盖率门禁。

请先阅读**[贡献指南](./CONTRIBUTING.zh-CN.md)**；完整本地流程、校验命令与恢复说明见
[DEVELOPMENT.zh-CN.md](./DEVELOPMENT.zh-CN.md)。欢迎提 issue 和 PR，动手前请先看
[行为准则](./CODE_OF_CONDUCT.zh-CN.md)；安全漏洞请走[安全策略](./SECURITY.zh-CN.md)，不要开公开 issue。

---

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。

本文档和界面中出现的他方商标，仅用于标识其对应产品。各商标的归属与我们遵守的条件见
[TRADEMARKS.zh-CN.md](./TRADEMARKS.zh-CN.md)。Claude 与 Claude Code 是 Anthropic PBC 的商标；
OpenTag 是独立项目，与 Anthropic 无隶属关系，也未获其赞助或背书。
