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
[![Node.js](https://img.shields.io/badge/node-22.13%20%7C%2024%20%7C%2026-5FA04E?style=flat&logo=node.js&logoColor=white)](#development)

[Website](https://opentag.build/?utm_source=github&utm_medium=readme&utm_campaign=opentag-site) · [Quickstart](#quickstart) · [Docs](#documentation) · [Development](./DEVELOPMENT.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

**English | [简体中文](./README.zh-CN.md)**

</div>

<p align="center">
  <img src="docs/assets/opentag-walkthrough.svg" alt="OpenTag in four steps: bring your own subscription, an AI worker in your team chat, shared knowledge kept on your own machine, and connecting the rest of your stack." width="100%">
</p>

> **Pre-alpha.** The control plane, the local runtime, and the Lark and Slack paths all work
> end to end today. Install and management workflows are still being finished, and public APIs may
> change before the first stable release. See [Project status](#project-status).

---

## What is OpenTag?

Your team already talks in Slack or Lark, and you already pay for Claude Code or Codex. But the
agent lives in a terminal on somebody's laptop. Every request has to be carried there by hand,
every answer carried back, and the context that made the request make sense stays in the channel
the agent never sees.

OpenTag puts the agent in the room. It is one bot the whole channel can address: someone tags it,
OpenTag routes that message to an Agent bound to a machine you enrolled, the agent runs there with
the credentials already on that machine, and it replies in the thread it was asked in. Nothing is
proxied through a vendor — OpenTag ships no model and holds no provider key. The server you run is
a control plane; the work happens on your hardware.

---

## Bring your own subscription.

*No vendor in the middle — not the model, not the key, not the machine.*

- **[Runtimes](#runtimes) →** Codex and Claude Code, invoked as the agent CLIs already installed and signed in on the machine you enrolled. OpenTag ships no model.
- **No key custody →** OpenTag never asks for a provider API key. The agent authenticates the way it already does there, on the plan you already pay for.
- **Runtime configuration →** Set a Codex Agent's model, reasoning effort, and maximum Turn duration from the Agent's **Runtime** tab or `agent update`. Leave a field blank and the choice stays with Codex; explicit values are validated by the bound Computer and never silently rewritten.
- **Your machine is the runtime →** Generate a 15-minute connect command in the Web, paste it on the machine that should do the work. It stores an enrollment-scoped credential and installs a per-user daemon on Linux and macOS.
- **Independent machine identity →** Signing in never starts a daemon; a daemon credential can never manage your account.

## An AI worker in your chat.

*One bot the whole channel shares — not a DM with a robot.*

- **[Lark and Slack](#chat-platforms) →** Bind an Agent to a workspace, invite it to a channel, and tag it.
- **[Channel and Thread Sessions](./docs/thread-sessions.md) →** Each channel keeps one long-lived Session; threads get their own when a real thread event arrives.
- **[Direct and ambient attention](./docs/thread-sessions.md) →** The agent knows whether it was addressed or is just listening, and decides for itself whether to reply, open a thread, or react.
- **[Replies through the provider's own CLI](./docs/direct-provider-cli.md) →** OpenTag hands the agent scoped IM credentials, so messages and reactions come from the agent's own judgment, not a templated bot response.
- **Durable delivery custody →** Inbound messages are persisted and handed over with explicit custody, and Agent/Computer bindings are fenced by revision — a restart mid-turn does not silently swallow the request, and a stale runtime cannot claim work that has moved on.

## Shared knowledge, kept by you.

*Context that outlives a terminal session, in files you can open.*

- **Context from every channel →** A Channel Session per Agent and channel, Thread Sessions materialized on demand with bounded root and thread history, so the agent starts from what was actually said rather than from a summary someone had to write.
- **Memory in plain files →** Agent work areas and runtime state live under `${OPENTAG_HOME}` on your own machine, private by default (`0700` / `0600`). Nothing is uploaded to a vendor to be remembered.
- **[Agents that talk to each other](./docs/internal-session-collaboration.md) →** Durable internal Session messaging with explicit retry, rather than best-effort silence.
- **Recovery you can reason about →** Reconnecting rotates credentials and rebuilds effective snapshots; work-area files stay yours to back up. [What survives what](./DEVELOPMENT.md)

## Connect your stack.

*The same tag reaches the rest of your tools.*

- **Through your machine, today →** The agent runs where your CLIs and credentials already are — `gh`, your cloud CLIs, your checkouts — so reaching them needs no OpenTag connector and no token handed to a third party.
- **A connector catalog is next →** The Integrations area in the Web is the interface preview for it. It is demo data today; see [Project status](#project-status).

## Own the whole thing.

*Your server, your database, your rules.*

- **Apache 2.0 →** No hosted-service carve-out, no commercial-use rider. [LICENSE](./LICENSE)
- **One container →** `ghcr.io/first-tree-ai/opentag`, published per commit. Point it at your own PostgreSQL. [Deployment guide](./docs/deploying.md)
- **Same-origin Web →** The management UI is served by the same server as the API; there is no third-party front end to trust.
- **[Observability](./docs/observability.md) →** OpenTelemetry traces and metrics to your own endpoint.

---

## Quickstart

Today OpenTag is built and run from a checkout. Published install channels are still being brought
up — see [Project status](#project-status).

**Prerequisites:** Node.js 22.13+ (22.x), 24.x, or 26.x · Corepack · pnpm 10.12.1 · Docker (for local PostgreSQL)

**1. Start the server.**

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

Migrations run before the server listens. It comes up on `http://127.0.0.1:8000`.

**2. Create the first account and install the CLI.** In another terminal:

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

Keep `~/.local/bin` first on `PATH` so the daemon service picks up this checkout's CLI and not an
older shim. For loopback development without Google credentials, set
`OPENTAG_DEV_AUTH_BYPASS_ENABLED=true` and `OPENTAG_DEV_AUTH_EMAIL` to the bootstrap email; the
bypass is rejected outside the `dev` environment and never creates accounts.

**3. Connect a computer.** Open `http://127.0.0.1:8000/`, sign in, and go to **Agents**. Generate a
Computer connection command — it is valid for 15 minutes — and run it on the machine that should do
the work:

```bash
opentag-dev computer connect --server http://127.0.0.1:8000 -- <computer-connect-code>
opentag-dev computer list     # the Computer should read as online
```

That command stores the machine credential and installs or restarts the per-user daemon. Pass
`--no-start` to store the credential without installing the service.

**4. Create an agent.**

```bash
opentag-dev agent create \
  --name code-reviewer \
  --display-name "Code Reviewer" \
  --provider codex
opentag-dev agent list
```

**5. Put it in a channel.** Bind the Agent to Lark or Slack from the Web, invite the bot to a
channel, and tag it. See [Chat platforms](#chat-platforms).

Full local workflow, validation commands, and recovery notes: **[DEVELOPMENT.md](./DEVELOPMENT.md)**.

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

## Development

```bash
corepack enable
pnpm install
pnpm check && pnpm build && pnpm typecheck && pnpm test
```

`pnpm lint` for lint-only feedback, `pnpm format` to apply Biome formatting. The required pull
request check is the `CI` fan-in job: the commands above plus source and staging CLI tarball
installs, a production-container health smoke, and the supported Node.js lines. Agent Runtime keeps
its own 100% coverage gate.

Start with the [Contributing guide](./CONTRIBUTING.md); the full local workflow is in
[DEVELOPMENT.md](./DEVELOPMENT.md).

---

## Project status

OpenTag is built in small, validated vertical slices, and `main` moves quickly.

**Working today:** the control plane and same-origin Web; account sign-in on Better Auth;
independently authenticated Computer enrollment, presence, and the per-user daemon on Linux and
macOS; the Agent registry with immutable Computer/provider binding and revision fencing; durable
Agent Runtime execution with delivery custody, reporting, and recovery; Lark and Slack inbound
normalization with Channel and Thread Session routing; direct provider CLI handoff for
agent-authored replies and reactions; internal Session collaboration; and the `doctor`, `login`,
`agent`, `computer`, `session`, and `daemon` commands.

**Not there yet:** published install channels — the npm and portable `curl … | sh` paths described
in [releasing.md](./docs/releasing.md) and [portable-release.md](./docs/portable-release.md) are
built but not yet serving a public release, so build from a checkout for now. Windows daemon
services are out of scope for v0.1. The Tasks, Skills, and Integrations areas of the Web are
interface previews backed by demo data, not working features. There is no hosted OpenTag; you run
the server.

The database still provisions an internal default Workspace and grant as a compatibility seam.
OpenTag exposes no Workspace, Admin, or invitation surface, and the accepted product shape is
**Account → Computer enrollment → Agent → IM binding**. Legacy active grants may let more than one
Account manage the same Agents until that seam is removed; they are not a shared collaboration
container.

---

## Why "OpenTag"

Because the whole product is one gesture. You already know how to ask a colleague for something in
a channel: you type `@` and their name. OpenTag makes that gesture reach a coding agent — and keeps
it open, so the agent is one you chose, on a machine you own, under a license that does not take it
back.

---

## License

OpenTag is licensed under the [Apache License 2.0](./LICENSE).
