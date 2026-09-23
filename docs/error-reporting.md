# Client error reporting

[简体中文](./zh-CN/error-reporting.md)

OpenTag relays failures that happen in the Web App and in the CLI to
[Google Cloud Error Reporting](https://cloud.google.com/error-reporting/), through the server. Neither client
holds a Google credential or talks to Google directly: each posts a small, redacted report to its own OpenTag
server, and the server forwards it with the official `@google-cloud/error-reporting` library. Server-side
failures are not part of this path; they are covered by [Server observability](./observability.md).

Reporting is always on in this version. There is no client-side switch, environment flag, or configuration
option that disables it. What an operator controls is the destination: a server without a Google Cloud project
keeps every report in its own log and forwards nothing.

## What is reported

Every report is one `ErrorReportRequest` (`packages/shared/src/error-report.ts`), validated strictly on the
server. Unknown fields are rejected, so a client cannot attach anything the schema does not name.

| Field | Source | Content |
| --- | --- | --- |
| `source` | both | `web` or `cli` |
| `message` | both | Redacted error message, at most 4 KiB |
| `stack` | both | Redacted stack trace, at most 16 KiB, when the runtime produced one |
| `code` | both | The stable diagnostic code, such as `unhandled_error` or `REQUEST_FAILED` |
| `version` | both | Web App build identity, or the CLI package version |
| `channel` | CLI | Release channel: `dev`, `staging`, or `prod` |
| `environment` | Web App | Vite mode, such as `production` |
| `url` | Web App | Page URL with the query string, fragment, and any credentials removed; the server strips them again on parse and rejects non-HTTP(S) URLs |
| `route` | Web App | The matched route template, such as `/agents/:agentId` |
| `command` | CLI | The command path such as `agent create`, never its arguments |
| `userAgent` | Web App | Browser user agent |
| `platform` | CLI | Operating system, architecture, and Node.js version, as `doctor` prints them |
| `occurredAt` | both | ISO 8601 timestamp |
| `reportId` | both | One identifier per report, tying the tracker event to the server log line |
| `userId` | both | The Account the client believed it was signed in as |
| `computerId` | CLI | The Account Computer this OpenTag home is connected as — the uuid the Server and the Web App know — read from the machine credential, when one exists |
| `installationId` | CLI | This installation's own locally generated identity (`computer.json`), the value the daemon logs under the same name; falls back to the machine credential's copy |
| `agentId`, `sessionId`, `turnId` | CLI | Present when the failure happened inside an Agent turn |
| `provider` | CLI | The Agent runtime provider, such as `claude-code` |

No token, cookie, or session field exists in the report. In Error Reporting the events appear under the services
`opentag-web` and `opentag-cli` with the report's `version` as the service version, so a regression can be
attributed to a release.

### Identity is attribution, not authorization

The relay is anonymous — it accepts a report from a client that has proved nothing — so every identifier in a
report is what the caller *claimed*, and the server does not verify any of it. Read `userId` as a lead for
whoever is diagnosing the failure, never as evidence of who someone is, and never as an authorization signal.
The [abuse surface](#abuse-surface) below says what follows from that.

Where each identifier comes from:

- **Web App.** The Account uuid the signed-in session resolved, attached alongside the analytics identity in
  `useAccountIdentityReport` (`apps/web/src/analytics/milestones.ts`) and cleared on both of a session's exits —
  signing out, and the Server refusing the next read. A failure before sign-in carries no `userId`.
- **CLI.** The Account recorded in `credentials.json` at sign-in, so a report can name it without a round trip
  on a path that is already failing. **An installation that signed in before this field existed reports no
  `userId` until it signs in again**; it still reports its Computer if one is connected. Signing in while the
  Server cannot answer `GET /me` also succeeds without recording the Account — the login is what matters there.

In the Error Reporting console the Account appears as `context.user`. A CLI report that names a Computer but no
Account is presented as `computer:<computerId>`, prefixed so the two kinds of identifier can never be confused.
Everything else in the table above — platform, route, Agent, Computer — is dropped by Error Reporting, which
keeps only the fields it defines. Those live on the server log line instead, and `reportId` is what joins the
two: the server writes it into the event's own text as a trailing `[reportId=<id>]` line, after the stack or
the message, so it is visible in the console and searchable there. The line comes last on purpose. Error
Reporting groups a stack trace by its exception type and five topmost frames, and a bare message by its first
three tokens, so the marker changes neither grouping. Searching the server log for the same `reportId` finds the
`Client error reported` line with the rest of the context.

The identity files are read independently on the CLI side: a malformed `computer.json` costs the report its
`installationId` and nothing else, and valid Account credentials alone are enough to address it.

### The page a Web App failure happened on

`url` names an object: `/agents/<uuid>/settings` is a different address for every Agent, so one defect arrives
as many pages and groups as none. `route` is the template those addresses share, projected from the matched
route the same way measurement projects it (`analyticsRoutePath`), so a segment reaches a report only because a
route file names it. An address the router did not match is reported as the single constant `/(not-found)`, and
a failure during the first resolve — before the router holds any match — carries no `route` rather than being
attributed to the root.

### Source lines in a CLI stack

The CLI ships as a bundle, so its stacks used to name `dist/cli/index.mjs` and a line number in it. The CLI now
builds with source maps and enables them in its entry point, so a frame in the CLI's own code resolves to the
file and line it was written on:

```text
at Module.runLogin (/path/to/apps/cli/src/core/auth/login.ts:31:21)
```

A frame inside `@opentag/client` or `@opentag/shared` resolves one hop, to that package's built
`dist/index.mjs` and a line in it, because the CLI bundles those packages from their build output and Node
applies one level of mapping rather than following a chain. The CLI's map names those files by a path relative
to the monorepo (`../../../packages/client/dist/index.mjs`, and likewise for `@opentag/shared`), which does not
exist in an end-user install, so Node never follows the second hop on its own. Those packages ship their own
`.map` files alongside, so a person holding the matching package tarball can resolve the second hop by hand from
the same release; it is not resolved automatically. The Web App is unchanged and its stacks stay minified.

The maps are an accepted size cost: they carry the full source of everything bundled, third-party code
included, and roughly triple the published `dist` of `open-tag`, `@opentag/client`, and `@opentag/shared`. The
bundler offers no way to drop the embedded source for third-party files alone, and a map without source text
would name a file the reader cannot open, so the whole map ships. Portable releases carry the maps too, beside
every chunk, because the entry point enables source maps and every chunk names its map.

## Where reports come from

**Web App.** The React error boundaries in `apps/web/src/features/error-boundary.tsx` (the application boundary,
route error pages, and React's root error handlers) and the window diagnostics in
`apps/web/src/observability/diagnostics.ts` (unhandled promise rejections, uncaught exceptions outside React such
as a timer or native event listener, and same-origin resource load failures) already log every failure to the
console; they now also hand it to the error report sink installed in `src/main.tsx`. Only error-level
diagnostics are relayed; warnings are handled or degraded paths, not defects, and React's recoverable errors
(a hydration mismatch, for one) stay on the console path because React already repaired them.
Identical code-and-message pairs are sent once per 30 seconds, because one render failure is observed by more
than one boundary; the table behind that cooldown drops expired entries and holds at most 200 distinct failures.
Same-origin resource load failures are deduplicated by code alone, not per path: after a deploy, a browser still
running the previous build asks for chunk hashes that no longer exist, and that produces one relayed
`resource_load_failed` per cooldown rather than one per missing file. Expect that report after every deploy; it
is a stale client, not a defect. The build identity comes from `OPENTAG_WEB_VERSION` at build time and falls
back to the package version.

**CLI and daemon.** The CLI entry point (`apps/cli/src/cli/index.ts`) reports a command failure after presenting
it, and only when the failure describes the program rather than the caller: categories `internal`, `dependency`,
and `protocol`. Validation, authentication, authorization, not-found, configuration, and cancellation outcomes
are answers, not defects, and are not reported. The same entry point installs `process.on("uncaughtException")`
and `process.on("unhandledRejection")` handlers (`installProcessErrorReporting` in `@opentag/client`) that log
through the client logger, wait at most two seconds for the report, write the failure to stderr and wait for
that write to drain (at most one second, so a piped stderr keeps the output), and exit with code 1 — the code
Node would have used. Because the daemon service runs through the CLI (`daemon service-run`), it is
covered by the same handlers, and an unexpected terminal daemon failure is reported before the process exits.

**Agent turns.** A turn that fails inside the daemon never reaches a terminal, so the tracker is the only place
it can be seen. The turn runner hands every turn that did not complete to the reporter installed by
`apps/cli/src/core/daemon/runtime.ts` — a value the provider threw and a failed result it returned alike — and
the reporter applies the same judgement the command path applies: only failures that describe OpenTag are
relayed, which today means `provider_protocol_error` and `turn_state_unknown`. The first is a provider that
answered in a shape the runtime could not read, and it keeps that name whether the provider threw it or returned
it. The second is the important one, being the catch-all for a throw nothing classified. A provider that is not
installed or refused the prompt, a credential the Account has not supplied, a sandbox this machine cannot open, a
budget that ran out, and a shutdown are answers the runtime gave on purpose, and no release can fix them, so they
stay on the log; declining them is the reporter's decision, not the runner's. `provider_teardown_failed` and
`session_resume_failed` exist in the shared taxonomy but nothing in the Client produces them yet, so the reporter
does not claim to relay them. The report names the Agent, the Session, the turn, and the provider the composed
runtime ran the Session on, when it can still say; a failure filed before the runtime was prepared names no
provider. One failure per Session and reason is relayed per 30 seconds, the same cooldown the Web App applies,
because the daemon is long-lived and a Session whose every turn fails the same way would otherwise post one
report per turn. The relay is not waited on: a slow tracker must not hold a turn open.

A CLI report goes to the server this installation is connected to: the Account credentials' server URL, or the
Computer identity's when only machine credentials exist. A CLI that has never logged in or connected sends
nothing. Each report waits at most three seconds for the relay.

## The relay endpoint

`POST /api/v1/error-reports` (`HTTP_PATHS.errorReports`) is anonymous: a failure before sign-in is still a
failure worth seeing, and the CSRF double-submit check applies only to authenticated browser mutations. The
route:

1. Rate limits by client address, 30 reports per minute per address, answering `429` beyond that. The budget is
   per process, the same trade-off the browser sign-in routes make; a shared limiter belongs at the gateway. The
   address is the socket peer unless `OPENTAG_TRUST_PROXY` names the reverse proxy (see
   [Behind a reverse proxy](#behind-a-reverse-proxy)); without it, every report behind a proxy arrives from the
   proxy's address and the whole deployment shares one 30-per-minute budget, and clients that exceed it fail
   silently.
2. Validates the body against `ErrorReportRequestSchema`; an unknown field, an oversized value, or a `url` that is
   not HTTP(S) answers `400`. Parsing also strips the URL's query string, fragment, and credentials, so the contract
   holds even for a client that did not honour it. A body over 128 KiB answers `413` without being read. The
   schema bounds each field in UTF-16 code units, not bytes, and a maximal report written entirely in CJK — the
   product ships a Chinese UI — is roughly 71 KB on the wire, so the limit leaves room for that and for JSON
   escaping while staying far below Fastify's 1 MiB default, which an anonymous route has no reason to accept.
3. Redacts the report again with `redactForLog` and writes it to the server log at `warn` as
   `Client error reported` with `module=error-reporting`, `source`, `errorCode`, `reportId`, `userId`, and the
   `errorReport` payload. The two identifiers are lifted out of the payload so an operator can filter on them
   without parsing it, and they are lifted from the redacted copy, never from the raw event: the relay is
   anonymous, so a caller can post a credential-shaped value as either, and it is scrubbed at the top level
   exactly as inside the payload. This line is where a report's full context lives, because Error Reporting keeps
   only the fields it defines; an operator without a Google Cloud project still sees every report here.
4. Answers `202` with an empty body and `cache-control: no-store` as soon as the report is accepted. Forwarding
   runs in the background. The reporter waits at most five seconds for each forward and then logs it as failed,
   because the Google client sets no deadline of its own and retries with backoff. That bounds the wait, not the
   library's own HTTP request and retries, which may continue in the background; a slow or blocked egress
   therefore never holds a client connection open.

### Abuse surface

The endpoint is anonymous by design, so anyone who can reach the server can post text that lands in the
operator's `warn` log and, when forwarding is enabled, in the Error Reporting console under `opentag-web` or
`opentag-cli` with a caller-chosen `version`. That extends to every identifier: a caller can post any `userId`,
`computerId`, or `agentId` it likes, and nothing here checks them, so a report attributed to an Account is not
evidence that Account did anything. The schema bounds each field and rejects unknown ones, the body is capped
well below Fastify's default, redaction runs twice, and the per-address rate limit is the only volume control —
with the proxy caveat above. Treat relayed text as untrusted input when reading it, and put a gateway limit in
front if the deployment is exposed to hostile traffic.

## Redaction

Reports are redacted twice, once on the client and once on the server, with the shared scrubber in
`@opentag/shared` (`redactSensitive`, `redactForLog`) that the [error taxonomy](./error-taxonomy.md) documents.
Bearer and basic credentials, `Authorization` and cookie headers, `token=`/`secret=`/`password=`-shaped values,
and database URLs are replaced with `[REDACTED]`. The Web App additionally applies its flat-string redactor to
messages, stacks, and component stacks before anything leaves the browser, and the URL is stripped of its query
string and fragment on the client. Message and stack are truncated to the schema bounds rather than rejected.

## Server configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | unset | The Google Cloud project that receives forwarded reports; unset disables forwarding unless the key below names one |
| `OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON` | unset | The whole service account key file as one value; unset uses Application Default Credentials |
| `OPENTAG_TRUST_PROXY` | `false` | Reverse proxies trusted to set `X-Forwarded-*`; see [Behind a reverse proxy](#behind-a-reverse-proxy) |

Credentials come from one of two places:

- `OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON`, for platforms that can set environment variables but cannot mount
  a file, such as CapRover. Paste the key file's JSON as the value. The server accepts only a
  `service_account` key, keeps its `client_email`, `private_key`, and `project_id`, never logs the value, and
  fails to start with a message that names the variable but not its content when the value is not such a key.
  When `GOOGLE_CLOUD_PROJECT` is unset, the key's `project_id` is used, so the key alone enables forwarding.
- Otherwise Application Default Credentials: Workload Identity or the attached service account on
  Google-managed compute, or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a key file mounted into the container.

Either way:

- Do not commit the key, bake it into an image layer, or place it in `.env.example`.
- The identity needs the `roles/errorreporting.writer` role on the project, and nothing more.
- Enable the Error Reporting API (`clouderrorreporting.googleapis.com`) on the project.

The reporter is constructed on the first report, uses `reportMode: "always"` so a staging container reports
without `NODE_ENV=production`, and keeps the library's own console output to genuine errors such as missing
credentials. Restart the server after changing the variable.

When `GOOGLE_CLOUD_PROJECT` is unset the server logs one `info` line on the first report —
`Error reports are logged only; GOOGLE_CLOUD_PROJECT is not set` — and otherwise behaves identically: the relay
route, validation, rate limit, and `warn` log line are all present. Self-hosted deployments therefore run this
feature with no Google dependency at all.

### Behind a reverse proxy

By default the server ignores `X-Forwarded-*` and keys every per-address limit on the socket peer. Behind a
reverse proxy that is the proxy, so set `OPENTAG_TRUST_PROXY` to the addresses the proxy connects from:

- A comma-separated list of IP addresses, CIDR ranges, and the presets `loopback`, `linklocal`, and
  `uniquelocal` (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). CapRover's nginx reaches the
  app over the Docker overlay network, so `uniquelocal` fits it.
- `true` trusts every peer. Use it only when nothing but the proxy can reach the server, because any direct
  client could then choose its own address by sending the header.
- A hop count is rejected: Fastify cannot validate the immediate peer from a count and ignores it.

The setting applies to the whole server, not only this route: the browser sign-in rate limits key on the same
address, and `request.hostname` and `request.protocol` then come from `X-Forwarded-Host` and
`X-Forwarded-Proto` when the peer is trusted.

## Failure path

Nothing in this path is allowed to affect the person using the product.

- The Web App sink swallows a rejected or throwing `fetch` and never writes to the console, so a reporting
  failure cannot produce a second error report.
- The CLI reports after it has already presented the failure and set its exit code; a slow or unreachable relay
  delays exit by at most three seconds and changes nothing else.
- The server answers `202` before forwarding starts, and a forward that the Google Cloud library rejects or that
  is still pending after five seconds is logged at `warn` as
  `Forwarding an error report to Google Cloud Error Reporting failed`.
- A report the schema rejects is the client's bug, answered with the shared `VALIDATION_ERROR` envelope, and is
  not forwarded.
