<div align="center">

<img src="https://opentag.build/assets/opentag-logo.png" alt="OpenTag" width="72">

# OpenTag

**Open source Claude Tag alternative.**

An AI worker in your Slack and Lark. Tag it in a thread and it does the work — running the
coding agent and model plan you already pay for, with its memory in plain files on your own machine.
Free and Apache 2.0: own your tag, own your memory, bring your own plan. It runs on your machine,
not on ours.

[![CI](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml/badge.svg)](https://github.com/first-tree-ai/opentag/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/first-tree-ai/opentag?style=flat)](https://github.com/first-tree-ai/opentag/stargazers)
[![Node.js](https://img.shields.io/badge/node-22.13%20%7C%2024%20%7C%2026-5FA04E?style=flat&logo=node.js&logoColor=white)](#contributing)

[Website](https://opentag.build/?utm_source=github&utm_medium=readme&utm_campaign=opentag-site) · [Quickstart](#quickstart) · [Docs](#documentation) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

**English | [简体中文](./README.zh-CN.md)**

</div>

<p align="center">
  <img src="docs/assets/opentag-walkthrough.gif" alt="OpenTag in four steps: bring your own subscription, an AI worker in your team chat, shared knowledge kept on your own machine, and connecting the rest of your stack." width="100%">
</p>

> **Pre-alpha.** The control plane, the local runtime, and the Lark and Slack paths work end to
> end today. Install workflows are still being finished and public APIs may change before the first
> stable release. The Tasks, Skills, and Integrations areas of the Web are interface previews backed
> by demo data.

---

## What is OpenTag?

You already pay for Claude Code or Codex, but the agent lives in a terminal on one person's laptop.
OpenTag puts it in the room: one bot the whole channel shares, running on a machine you own.

- **[Lark and Slack](#chat-platforms) →** Bind an Agent, invite it to a channel, tag it.
- **[Channel and Thread Sessions](./docs/thread-sessions.md) →** One long-lived Session per channel; threads get their own on demand.
- **[It answers as itself](./docs/direct-provider-cli.md) →** The agent holds scoped IM credentials and decides whether to reply, open a thread, or react.
- **Nothing gets dropped →** Messages are persisted and handed over with explicit custody; Agent bindings are fenced by revision.

---

## Own your context.

*Context that outlives a terminal session, in files you can open.*

- **From every channel →** Thread Sessions carry bounded root and thread history, so the agent starts from what was actually said.
- **In plain files →** Work areas and runtime state live under `${OPENTAG_HOME}` on your machine, private by default. Nothing is uploaded to be remembered for you.
- **[Agents that talk to each other](./docs/internal-session-collaboration.md) →** Durable internal Sessions with explicit retry.

## Connect your stack.

*The same tag reaches the rest of your tools.*

- **Through your machine →** The agent runs where your CLIs and credentials already are — `gh`, your cloud CLIs, your checkouts. No token handed to a third party.
- **A connector catalog is next →** The Integrations area in the Web is its interface preview today.

## Own the whole thing.

*Own your tag, own your context, bring your own plan.*

- **No model lock-in →** [Codex and Claude Code](#runtimes) run as the CLIs already signed in on your machine. OpenTag ships no model and never asks for a provider key.
- **Own your org's context →** It accumulates on hardware you control, not in a vendor account you can be locked out of.
- **Own the tag →** Apache 2.0, no hosted-service carve-out and no commercial-use rider. [LICENSE](./LICENSE)
- **Run it anywhere →** `ghcr.io/first-tree-ai/opentag`, published per commit, pointed at your own PostgreSQL. [Deployment guide](./docs/deploying.md)

---

## Quickstart

The one prerequisite: the machine that will run agents needs an [agent CLI](#runtimes) — `codex` or
`claude` — installed and signed in. OpenTag drives them; it doesn't ship them.

```bash
git clone https://github.com/first-tree-ai/opentag.git && cd opentag
pnpm install && ./scripts/dev-install.sh
```

Needs Node.js 22.13+, Corepack, and pnpm 10.12.1. `dev-install.sh` puts `opentag-dev` on your
`PATH`. Published npm and one-line installers are on the way.

<details>
<summary><b>Running the server</b></summary>

<br/>

```bash
docker compose up -d postgres
export OPENTAG_DATABASE_URL=postgresql://opentag:opentag@localhost:5432/opentag
export OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export OPENTAG_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OPENTAG_PUBLIC_URL=http://127.0.0.1:8000
pnpm build && pnpm --filter @opentag/server start
pnpm --filter @opentag/server bootstrap:admin   # prints the first account login code
```

Migrations run before the server listens. The [deployment guide](./docs/deploying.md) covers running
it on your own infrastructure instead.

</details>

---

## Your first agent in five minutes

**1. Sign in.** `opentag-dev login --server <your-server> -- <account-login-code>`, then open the Web
at that same URL.

**2. Connect a computer.** A *Computer* is any machine agents can work on — your laptop, or a cloud
box. Open **Agents** in the Web, generate a connection command, and run it on that machine:

```bash
opentag-dev computer connect --server <your-server> -- <computer-connect-code>
opentag-dev computer list     # the Computer should read as online
```

It stores an enrollment-scoped credential and installs a per-user daemon on Linux and macOS.

**3. Create an agent.**

```bash
opentag-dev agent create --name code-reviewer --display-name "Code Reviewer" --provider codex
```

**4. Put it in a channel.** Bind the Agent to Lark or Slack from the Web, invite the bot, and tag it.

Full walkthrough: [DEVELOPMENT.md](./DEVELOPMENT.md) · [Chat platforms](#chat-platforms)

---

## Runtimes

OpenTag does not ship a model. It drives the agent CLI already installed and authenticated on the
enrolled Computer, so switching providers is a field on the Agent, not a migration.

| Provider | CLI | Runtime configuration |
| --- | --- | --- |
| OpenAI Codex | `codex` | Model, reasoning effort, and max Turn duration, validated by the bound Computer |
| Claude Code | `claude` | Supported as a runtime; Effective Runtime Snapshots are not exposed yet |

## Chat platforms

| Platform | How it binds | Setup |
| --- | --- | --- |
| Lark / Feishu | Custom app, bound from the Agent's IM setup flow in the Web | In-product |
| Slack | OAuth install plus an events endpoint on your `OPENTAG_PUBLIC_URL` | [Slack App configuration](./docs/slack-app-setup.md) |

Both platforms share the same routing: one Channel Session per Agent and channel, Thread Sessions
materialized on demand, and replies sent by the agent through the provider's own CLI.

---

## Architecture

```text
        Slack  ·  Lark / Feishu            Browser (same-origin Web)
                     │                              │
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐      ┌───────────────┐
                     │   OpenTag Server (Fastify)   │─────>│  PostgreSQL   │
                     │   REST · Better Auth · WS    │<─────│               │
                     └──────────────┬───────────────┘      └───────────────┘
                                    │  Runtime protocol over WebSocket
                                    ▼
                     ┌──────────────────────────────┐
                     │   OpenTag daemon             │  your laptop or cloud box
                     │   (per-user service)         │  next to your code
                     └──────────────┬───────────────┘
                                    │  spawns
                     ┌──────────────┴───────────────┐
                     │   codex  ·  claude           │  your CLI, your plan
                     └──────────────────────────────┘
```

| Layer | Stack |
| --- | --- |
| Server | Fastify, Better Auth, PostgreSQL migrations, Computer WebSocket endpoint |
| Web | React, served same-origin by the Server |
| CLI | Commander; `opentag-dev` from a checkout, `opentag` once install channels ship |
| Client / daemon | TypeScript runtime that enrolls a Computer and executes Agent Turns |
| Shared | Zod schemas and HTTP path contracts used by every workspace |

Wire-level details: [Runtime protocol](./docs/runtime-protocol.md).

---

## Documentation

| I want to… | Start here |
| --- | --- |
| Get it running locally | [Quickstart](#quickstart) · [Development guide](./DEVELOPMENT.md) |
| Understand how messages reach an agent | [IM Channel and Thread Sessions](./docs/thread-sessions.md) · [Runtime protocol](./docs/runtime-protocol.md) |
| Let the agent reply and react on its own | [Direct provider CLI messaging](./docs/direct-provider-cli.md) |
| Connect Slack | [Slack App configuration](./docs/slack-app-setup.md) |
| Have agents talk to each other | [Internal Session collaboration](./docs/internal-session-collaboration.md) |
| Run it on my own infrastructure | [Deployment guide](./docs/deploying.md) · [Observability](./docs/observability.md) |
| Ship or install a build | [Release guide](./docs/releasing.md) · [Portable release guide](./docs/portable-release.md) |
| Contribute | [Contributing guide](./CONTRIBUTING.md) · [Code of Conduct](./CODE_OF_CONDUCT.md) |
| Report a vulnerability | [Security policy](./SECURITY.md) |

Chinese translations live in [`docs/zh-CN/`](./docs/zh-CN).

---

## Contributing

OpenTag is built in small, validated vertical slices, and `main` moves quickly — pull often.

```bash
pnpm install
pnpm check && pnpm build && pnpm typecheck && pnpm test
```

That is the required pull request check, the `CI` fan-in job, minus the CLI tarball installs and the
container smoke it also runs. Agent Runtime keeps its own 100% coverage gate.

Start with the **[Contributing guide](./CONTRIBUTING.md)**; the full local workflow, validation
commands, and recovery notes are in [DEVELOPMENT.md](./DEVELOPMENT.md). Issues and pull requests are
welcome — please read the [Code of Conduct](./CODE_OF_CONDUCT.md) first, and report vulnerabilities
through the [Security policy](./SECURITY.md) rather than a public issue.

---

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).
