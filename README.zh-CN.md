<div align="center">

<img src="https://opentag.build/assets/opentag-logo.png" alt="OpenTag" width="72">

# OpenTag

__你的模型、你的机器、你的 AI 同事__

[![CI](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml/badge.svg)](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/first-tree-ai/opentag?style=flat)](https://github.com/first-tree-ai/opentag/stargazers)

[官网](https://opentag.build/zh?utm_source=github&utm_medium=readme&utm_campaign=opentag-site) · [快速开始](#快速开始) · [文档](#文档) · [贡献指南](./CONTRIBUTING.zh-CN.md) · [安全策略](./SECURITY.zh-CN.md)

**[English](./README.md) | 简体中文**

</div>

## 关于

OpenTag 是一个开源、多模型的 AI 同事。在 Slack 和飞书里，和运行在你自己的机器上、使用你自己
选的模型提供方的 AI agent 对话。

- **在 Slack 或飞书里给 agent 发消息** - 它在本地运行、在频道里回复
- **agent 之间可以互相沟通**，一个 agent 可以委派任务给其他 agent 并检查进度
- **自带** Claude 或 Codex agent（更多即将推出！）
- **开源**、**可自托管**

> 权威来源：[README.md](./README.md)　·　同步日期：2026-09-07

<p align="center">
  <img src="docs/assets/opentag-walkthrough.gif" alt="OpenTag 的四个步骤：自带订阅、团队群里的 AI worker、留在你自己机器上的共享知识，以及连接你的其余工具。" width="100%">
</p>

## 快速开始

请在已克隆仓库的根目录运行以下本地部署命令；高级配置见[开发指南](./DEVELOPMENT.zh-CN.md)。

### 1. 安装 OpenTag

在 macOS 或 Linux 上准备 Node.js 24（24.15.0 或更高的 24.x 版本）、pnpm 10.12.1、支持 Compose 的 Docker，以及已登录的 Codex 或 Claude Code CLI。

```bash
./scripts/dev-install.sh
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
```

### 2. 启动本地 Server

等待 PostgreSQL 就绪、生成密钥、启用仅限回环地址的开发者登录，并在启动前台 Server 之前初始化账号：

```bash
docker compose up -d --wait postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@127.0.0.1:5432/opentag
export OPENTAG_JWT_SECRET=$(openssl rand -base64 32)
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_ENV=dev
export OPENTAG_HOST=127.0.0.1
export OPENTAG_PORT=8000
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
export OPENTAG_BOOTSTRAP_EMAIL=admin@example.com
export OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin
export OPENTAG_DEV_AUTH_BYPASS_ENABLED=true
export OPENTAG_DEV_AUTH_EMAIL="$OPENTAG_BOOTSTRAP_EMAIL"

pnpm --filter @opentag/server bootstrap:admin
pnpm --filter @opentag/server start
```

### 3. 连接你的 Agent

打开 <http://127.0.0.1:8000>，选择**开发者登录**，按照 **Agents** 设置流程创建 Agent，在第二个终端中先设置下面的 PATH 再运行页面生成的连接命令，最后连接聊天平台。

```bash
export PATH="$HOME/.local/bin${PATH:+:$PATH}"
# 粘贴并运行 Agents 设置流程生成的连接命令。
```

可以选择 Codex 或 Claude Code，搭配飞书 / Lark 或 Slack；按照产品内的聊天设置流程操作，Slack 还需要[额外配置](./docs/zh-CN/slack-app-setup.md)。

## 文档

- [开发指南](./DEVELOPMENT.zh-CN.md) — 本地工作流程、架构和高级配置。
- 聊天设置 — 飞书 / Lark 在 Agents 设置流程中完成；[Slack App 配置](./docs/zh-CN/slack-app-setup.md)。
- [技术文档](./docs/zh-CN/README.md) — 专题指南，包括 staging 部署指南。
- [贡献指南](./CONTRIBUTING.zh-CN.md) — 开发检查和 pull request 流程。

## 项目状态

OpenTag 处于 pre-alpha：首个稳定版本发布前，公开 API 和包边界仍可能变化。
请从源码 checkout 构建；npm 和便携安装渠道尚未公开提供。
v0.1 不支持 Windows daemon service，Skills 和 Integrations 页面使用演示数据。
OpenTag 没有托管服务，需要自行运行 Server。

## 参与贡献

欢迎提交 issue 和 pull request；请先阅读[贡献指南](./CONTRIBUTING.zh-CN.md)和
[行为准则](./CODE_OF_CONDUCT.zh-CN.md)，并通过[安全策略](./SECURITY.zh-CN.md)报告漏洞。

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。

本文档和界面中出现的他方商标，仅用于标识其对应产品。各商标的归属与我们遵守的条件见
[TRADEMARKS.zh-CN.md](./TRADEMARKS.zh-CN.md)。Claude 与 Claude Code 是 Anthropic PBC 的商标；
OpenTag 是独立项目，与 Anthropic 无隶属关系，也未获其赞助或背书。
