# Web tools

[简体中文](./zh-CN/web-tools.md)

## Scope

Web tools expose `web_search` and `web_fetch` to Pi Agent Runs through OpenTag-managed Tavily access. Web access is a
**default platform capability** — on par with platform LLM access — not a per-Account key, an opt-in step, or a user
setting. A deployment that has not configured the platform Web provider still fails closed: no grant, no bearer, no
socket, no extension.

Two boundaries consume the same Server routes:

- **Local Computer** executions in proxy credential mode, when the daemon was started with the Local opt-in below.
- **Cloud Runner** executions (IM turns and internal Session collaborations), whenever the Server grants the `web`
  service. The Cloud path has no Runner-side switch: the grant is the gate.

## Server configuration (Tavily access)

OpenTag Server talks to the existing Router over fixed HTTPS routes and presents a **single deployment-wide Router
web-only key**. The Tavily provider key itself never leaves the Router gateway; OpenTag Server never holds it.

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENTAG_WEB_ENABLED` | yes (default `false`) | Deployment-wide switch for Server-side web forwarding |
| `OPENTAG_WEB_ROUTER_BASE_URL` | yes when enabled | Router origin only (no path/query/fragment/credentials). HTTPS is enforced in hosted environments |
| `OPENTAG_WEB_ROUTER_KEY` | yes when enabled | The Router web-only key. Read at startup, trimmed like every other deployment secret, and never logged, sent to a Sandbox, or placed in a request body |

Synthetic example (never use a real key in this file or in source):

```text
OPENTAG_WEB_ENABLED=true
OPENTAG_WEB_ROUTER_BASE_URL=https://router.example.internal
OPENTAG_WEB_ROUTER_KEY=synthetic-router-web-key
```

Enabling without the origin or the key is a startup error, not a silent fallback. The per-Account tenant map
(`OPENTAG_WEB_ROUTER_TENANTS` and its `keyEnv` references) is removed; a deployment that still carries only that
variable has no Router key and fails closed at startup.

When the deployment is enabled, the web policy grants `web:search` and `web:fetch` to **every valid active Account
execution** that requests the service, exactly like platform model access. There is no per-Account mapping and no
user-facing switch.

Router billing is **shared across Accounts** in this implementation; OpenTag does not claim per-Account Router billing.
What OpenTag does retain is the authenticated Account ID in its own structured usage logging (`WEB_DISPATCH`: code,
Account, execution, operation) and in the request's Account attribution, with **no query content and no credentials**.
The Account is read from the live execution record, never from the request body.

The Router must already carry its own migration that adds `api_keys(scopes)`, web service pricing, and the web
request/usage-ledger columns; that migration is owned by the Router repository. OpenTag adds no new tables, no new
service, and no database migration for this feature. There is no LiteLLM involvement of any kind.

## Local client opt-in

| Variable | Where | Meaning |
| --- | --- | --- |
| `OPENTAG_WEB_TOOLS_ENABLED` | CLI daemon environment (`daemon.env`) | Local opt-in. Accepts only exact `true`/`false`; any other value fails startup |
| `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` | CLI daemon environment | Required; the legacy mode never opens executions and never enables web tools |

The native Runner has **no** web opt-in. `OPENTAG_RUNNER_WEB_TOOLS` was removed; a Cloud turn gets web tools exactly
when the Server granted the `web` service for that execution and the Runner holds the packaged extension artifact.

An opt-in flag alone never grants tools. The Server must also negotiate the `webTools` capability and grant the
execution the `web` service with `web:search` / `web:fetch` scopes. Without a grant the Pi extension does not register
and no endpoint exists.

## Cloud execution custody

- The per-Sandbox Runner connection negotiates `runtime.webTools` and requests `web` on every real IM and internal
  Session execution open. The Server grants only after the existing custody, Session, sandbox, and connection fences.
- The execution-scoped web bearer is issued through the existing credential tunnel (`runtime:web:gateway`), from a
  bounded hash-only store, with a lifetime capped by the execution's own expiry. It is **never** placed on the open
  result, in the worker stdin document, in the journal, or in a log.
- The bearer lives only in the trusted Runner **parent**. `RuntimeWebService` remains the only component that holds the
  Router key; the parent calls the two fixed routes with the bearer, and the Server derives the Computer identity from
  the live execution and requires the request's `executionId` to match the bearer.
- The routes accept the bearer **in addition to** Local machine authentication. A Cloud control credential is refused
  there: it is never treated as a machine token or as web authorization.
- The native gateway opens exactly one channel per granted execution: a fresh `sandbox exec` stdin/stdout duplex whose
  listener lives inside the Sandbox namespace. No parent socket is mounted, no TCP listener is opened, and results do
  **not** travel over the 256 KiB control WebSocket.
- The channel is closed before the Sandbox is deleted or reset and when the execution ends. Revocation, control
  connection replacement, owner loss, and the stale sweep all revoke the bearer at the one place executions close, so a
  stale token or socket cannot reach a successor execution.
- Only the nonsecret socket descriptor and the fixed packaged extension path
  (`/opt/opentag/client/dist/pi-extensions/web-tools.mjs`) travel to the Cloud worker via bounded stdin. Pi registers
  the extension explicitly (`provider.webTools`), and `--no-extensions` keeps implicit discovery off.
- If the Server grants Web but the execution bearer, packaged extension, or native channel is unavailable, the turn
  fails explicitly. It must not complete while silently lacking the platform's default Web tools.

## Key custody and isolation

- The Tavily key lives only in the Router gateway. OpenTag Server holds only the deployment-wide Router web-only key.
- The trusted CLI/daemon continues to hold its existing Computer machine/control credential and to negotiate
  capabilities at the control boundary; that trusted host authentication is unchanged. The **Tavily key and the Router
  web-only key** never leave Router/Server custody: they never enter the Agent process, the Sandbox, request bodies,
  error messages, or logs. Web requests carry business parameters and the runtime-generated tool call id only.
- Local executions get one fresh, short, private per-execution Unix socket; a stale descriptor from an earlier
  execution can never reach a successor, and closing one execution removes only its own listener.
- Cloud executions get one fresh per-execution `sandbox exec` duplex pipe; the channel is closed with the execution and
  a successor obtains its own bearer, socket, and channel.
- The trusted Pi extension is the built artifact `dist/pi-extensions/web-tools.mjs`, shipped with the Client package,
  the npm CLI, and portable artifacts. It loads explicitly with `pi -e`; `--no-extensions` stays set so implicit
  discovery never loads anything, and help/probe commands never load the extension.

## Budgets, errors, and artifacts

- One decreasing end-to-end budget flows across the tool, gateway, trusted client, Server, and Router: **15 s** for
  search, **45 s** for fetch. The in-Sandbox/trusted gateway takes the strict 1–7-digit decimal `x-web-remaining-ms`
  header (a positive integer), caps it at the operation limit, starts the deadline **before** reading the body, and
  forwards only the remainder after the body. The trusted Client → Server → Router HTTP hop uses `x-web-timeout-ms`
  with the same 1–7-digit positive decimal grammar; it is reconstructed at each trusted boundary and never resets to
  the full cap.
- Errors are bounded and redacted on every hop: `request_in_progress`, `request_uncertain`, `insufficient_credit`,
  `idempotency_conflict`, `result_unavailable`, `timeout`, `aborted`, and the shared error taxonomy. Pi records
  operation failures as tool errors, never as success text.
- Bounds: request ≤16 KiB, URL ≤4 KiB, page body ≤1 MiB, per-page model preview ≤12 KiB, whole tool result ≤48 KiB,
  search response ≤1 MiB, fetch response ≤3 MiB.
- Extracted pages are written under the Session workspace `.opentag/web/<stable-tool-id>/` with atomic writes and
  sha256 metadata. A write failure reports a missing artifact instead of a fabricated path.

## Verification and limits

Unit tests cover the gateway, trusted Server client, execution web dispatch, native bridge, relay bearer fetch, Cloud
turn wiring (grant/no-grant, dispatch, successor execution), the Server route (bearer and machine auth), the Server
fence, the token stores, and the Pi extension against **local stub transport** only. Tests make no vendor call.

Cloud web tools have **not** been exercised end to end against a real staging deployment (real Router, real Cloud
Runner, real Sandbox) in this change. Treat the Cloud path as implemented and unit-verified, not production-proven,
until that run exists. Local proxy mode keeps its previous behavior; MCP is unchanged.
