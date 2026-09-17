# Web tools

[简体中文](./zh-CN/web-tools.md)

## Scope

Web tools expose `web_search` and `web_fetch` to Pi Agent Runs through OpenTag-managed Tavily access. The feature
is **off by default**. Local Computer executions in proxy credential mode can enable it; native Cloud Runner
execution stays closed for business until a real per-execution authority issuer exists (E4), because the existing
native bootstrap credential is not an execution authority and is never used as one.

## Server configuration (Tavily access)

OpenTag Server talks to the existing Router over fixed HTTPS routes and presents a **Router web-only tenant
key**. The Tavily provider key itself never leaves the Router gateway; OpenTag Server never holds it.

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENTAG_WEB_ENABLED` | yes (default `false`) | Master switch for Server-side web forwarding |
| `OPENTAG_WEB_ROUTER_BASE_URL` | yes when enabled | Router origin only (no path/query/fragment/credentials). HTTPS is enforced in hosted environments |
| `OPENTAG_WEB_ROUTER_TENANTS` | yes when enabled | JSON array mapping Account → Router tenant: `[{"accountId":"<uuid>","tenantId":"<router-tenant-slug>","keyEnv":"OPENTAG_WEB_ROUTER_KEY_ACME"}]` |
| `OPENTAG_WEB_ROUTER_KEY_*` | yes per mapping | Deployment secret holding the Router web-only tenant key. Only the variable *name* is in the mapping; that name must match `^OPENTAG_WEB_ROUTER_KEY_[A-Z0-9_]{1,48}$` (the pattern constrains the variable name, not the secret value), and the secret is read at startup |

Synthetic example (never use a real key in this file or in source):

```text
OPENTAG_WEB_ENABLED=true
OPENTAG_WEB_ROUTER_BASE_URL=https://router.example.internal
OPENTAG_WEB_ROUTER_TENANTS=[{"accountId":"00000000-0000-4000-8000-000000000001","tenantId":"synthetic-tenant","keyEnv":"OPENTAG_WEB_ROUTER_KEY_SYNTHETIC"}]
OPENTAG_WEB_ROUTER_KEY_SYNTHETIC=synthetic-router-web-key
```

Enabling without the origin, a mapping, or readable key material is a startup error, not a silent fallback.

The Router must already carry its own migration that adds `api_keys(scopes)`, web service pricing, and the web
request/usage-ledger columns; that migration is owned by the Router repository. OpenTag adds no new tables, no
new service, and no database migration for this feature. There is no LiteLLM involvement of any kind.

## Local client opt-in

| Variable | Where | Meaning |
| --- | --- | --- |
| `OPENTAG_WEB_TOOLS_ENABLED` | CLI daemon environment (`daemon.env`) | Local opt-in. Accepts only exact `true`/`false`; any other value fails startup |
| `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` | CLI daemon environment | Required; the legacy mode never opens executions and never enables web tools |
| `OPENTAG_RUNNER_WEB_TOOLS` | Native Runner `serve` environment | Native boundary opt-in. Accepts only exact `true`/`false`; any other value fails startup |

An opt-in flag alone never grants tools. The Server must also negotiate the `webTools` capability at version 1 and
grant the execution the `web` service with `web:search` / `web:fetch` scopes. Without a grant the Pi extension does
not register and no endpoint exists. Native `serve` additionally needs an injected, Server-authorized execution
authority (`webAuthority` harness seam); production does not supply one yet, so E3 remains disabled.

## Key custody and isolation

- The Tavily key lives only in the Router gateway. OpenTag Server holds only a Router web-only tenant key, read
  from the deployment secret named by `keyEnv`.
- The trusted CLI/daemon continues to hold its existing Computer machine/control credential and to negotiate
  capabilities at the control boundary; that trusted host authentication is unchanged. The **Tavily key and the
  Router web-only tenant key** never leave Router/Server custody: they never enter the Agent process, the Sandbox,
  request bodies, error messages, or logs. Web requests carry business parameters and the runtime-generated tool
  call id only.
- Local executions get one fresh, short, private per-execution Unix socket; a stale descriptor from an earlier
  execution can never reach a successor, and closing one execution removes only its own listener.
- Native executions use a dedicated `sandbox exec` stdin/stdout duplex pipe; the listener lives inside the Sandbox
  namespace. No parent socket is mounted into the Sandbox and no TCP listener is opened.
- The trusted Pi extension is the built artifact `dist/pi-extensions/web-tools.mjs`, shipped with the Client
  package, the npm CLI, and portable artifacts. It loads explicitly with `pi -e`; `--no-extensions` stays set so
  implicit discovery never loads anything, and help/probe commands never load the extension.

## Budgets, errors, and artifacts

- One decreasing end-to-end budget flows across the tool, gateway, trusted client, Server, and Router: **15 s**
  for search, **45 s** for fetch. The in-Sandbox/trusted gateway takes the strict 1–7-digit decimal
  `x-web-remaining-ms` header (a positive integer), caps it at the operation limit, starts the deadline
  **before** reading the body,
  and forwards only the remainder after the body. The trusted Client → Server → Router HTTP hop uses
  `x-web-timeout-ms` with the same 1–7-digit positive decimal grammar; it is reconstructed at each trusted
  boundary and never resets to the full cap.
- Errors are bounded and redacted on every hop: `request_in_progress`, `request_uncertain`,
  `insufficient_credit`, `idempotency_conflict`, `result_unavailable`, `timeout`, `aborted`, and the shared error
  taxonomy. Pi records operation failures as tool errors, never as success text.
- Bounds: request ≤16 KiB, URL ≤4 KiB, page body ≤1 MiB, per-page model preview ≤12 KiB, whole tool result
  ≤48 KiB, search response ≤1 MiB, fetch response ≤3 MiB.
- Extracted pages are written under the Session workspace `.opentag/web/<stable-tool-id>/` with atomic writes and
  sha256 metadata. A write failure reports a missing artifact instead of a fabricated path.

## Verification and limits

Unit tests cover the gateway, trusted Server client, native bridge, and Pi extension against **local stub
transport** only. The parent cross-chain run exercises the actual Server and Router HTTP stack with a real
PostgreSQL and Redis test instance and a stub Tavily HTTP transport. There is **no real Tavily account
acceptance** in this repository, and no vendor call is made by tests. Native Cloud acceptance still requires the
E4 execution-authority issuer; until then the native path is exercised with an injected test authority.
