<div align="center">

<img src="https://opentag.build/assets/opentag-logo.png" alt="OpenTag" width="72">

# OpenTag

__你的模型、你的机器、你的 AI 同事__

[![CI](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml/badge.svg)](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/first-tree-ai/opentag?style=flat)](https://github.com/first-tree-ai/opentag/stargazers)

[官网](https://opentag.build/zh?utm_source=github&utm_medium=readme&utm_campaign=opentag-site) · [快速开始](#快速开始) · [文档](./docs/zh-CN/README.md) · [贡献指南](./CONTRIBUTING.zh-CN.md) · [安全策略](./SECURITY.zh-CN.md)

**[English](./README.md) | 简体中文**

</div>

## 关于

OpenTag 是一个开源、多模型的 AI 同事。在 Slack 和飞书里，和运行在你自己的机器上、使用你自己
选的模型提供方的 AI agent 对话。

- **在 Slack 或飞书里给 agent 发消息** - 它在本地运行、在频道里回复
- **agent 之间可以互相沟通**，一个 agent 可以委派任务给其他 agent 并检查进度
- **自带** Claude 或 Codex agent（更多即将推出！）
- **开源**、**可自托管**

> 权威来源：[README.md](./README.md)　·　同步日期：2026-09-09

<p align="center">
  <img src="docs/assets/opentag-walkthrough.gif" alt="OpenTag 的四个步骤：自带订阅、团队群里的 AI worker、留在你自己机器上的共享知识，以及连接你的其余工具。" width="100%">
</p>

## 快速开始

请准备一台 Mac 或 Linux 电脑、Codex 或 Claude Code Agent，并安装 Slack 或飞书。

### 1. 创建账号

打开 [app.opentag.build](https://app.opentag.build) 并登录。

### 2. 创建 Agent

进入 **Agents**，按照步骤选择 Agent 和聊天平台。

### 3. 连接电脑

复制设置过程中显示的连接命令。在你希望 Agent 工作的电脑上，打开终端应用，粘贴命令并按回车。
按照提示完成连接，并在需要时登录 Codex 或 Claude。Agent 工作期间，请保持这台电脑开机。

### 4. 开始聊天

完成剩余设置，将 OpenTag 添加到 Slack 或飞书，然后在频道或私信中给 Agent 发消息。
Slack 的额外设置步骤见[配置指南](./docs/zh-CN/slack-app-setup.md)。

## 自托管与本地开发

OpenTag 开源且可自托管。如需从源码在本地运行 Server，请按照开发指南中的
[从源码在本地运行](./DEVELOPMENT.zh-CN.md#从源码在本地运行)操作。

## 参与贡献

欢迎提交 issue 和 pull request；请先阅读[贡献指南](./CONTRIBUTING.zh-CN.md)和
[行为准则](./CODE_OF_CONDUCT.zh-CN.md)，并通过[安全策略](./SECURITY.zh-CN.md)报告漏洞。

## 许可证

OpenTag 使用 [Apache License 2.0](./LICENSE)。
