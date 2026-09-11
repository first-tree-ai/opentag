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
| `url` | Web App | Page URL with the query string, fragment, and any credentials removed |
| `command` | CLI | The command path such as `agent create`, never its arguments |
| `userAgent` | Web App | Browser user agent |
| `occurredAt` | both | ISO 8601 timestamp |

No account identifier, session, token, cookie, or user field exists in the report, and the server does not add
one. In Error Reporting the events appear under the services `opentag-web` and `opentag-cli` with the report's
`version` as the service version, so a regression can be attributed to a release.

## Where reports come from

**Web App.** The React error boundaries in `apps/web/src/features/error-boundary.tsx` (the application boundary,
route error pages, and React's root error handlers) and the window diagnostics in
`apps/web/src/observability/diagnostics.ts` (unhandled promise rejections and same-origin resource load failures)
already log every failure to the console; they now also hand it to the error report sink installed in
`src/main.tsx`. Only error-level diagnostics are relayed; warnings are handled or degraded paths, not defects.
Identical code-and-message pairs are sent once per 30 seconds, because one render failure is observed by more
than one boundary. The build identity comes from `OPENTAG_WEB_VERSION` at build time and falls back to the
package version.

**CLI and daemon.** The CLI entry point (`apps/cli/src/cli/index.ts`) reports a command failure after presenting
it, and only when the failure describes the program rather than the caller: categories `internal`, `dependency`,
and `protocol`. Validation, authentication, authorization, not-found, configuration, and cancellation outcomes
are answers, not defects, and are not reported. The same entry point installs `process.on("uncaughtException")`
and `process.on("unhandledRejection")` handlers (`installProcessErrorReporting` in `@opentag/client`) that log
through the client logger, wait at most two seconds for the report, print the failure, and exit with code 1 —
the codes Node would have used. Because the daemon service runs through the CLI (`daemon service-run`), it is
covered by the same handlers, and an unexpected terminal daemon failure is reported before the process exits.

A CLI report goes to the server this installation is connected to: the Account credentials' server URL, or the
Computer identity's when only machine credentials exist. A CLI that has never logged in or connected sends
nothing. Each report waits at most three seconds for the relay.

## The relay endpoint

`POST /api/v1/error-reports` (`HTTP_PATHS.errorReports`) is anonymous: a failure before sign-in is still a
failure worth seeing, and the CSRF double-submit check applies only to authenticated browser mutations. The
route:

1. Rate limits by client address, 30 reports per minute per address, answering `429` beyond that. The budget is
   per process, the same trade-off the browser sign-in routes make; a shared limiter belongs at the gateway.
2. Validates the body against `ErrorReportRequestSchema`; an unknown field or an oversized value answers `400`.
3. Redacts the report again with `redactForLog` and writes it to the server log at `warn` as
   `Client error reported` with `module=error-reporting`, `source`, `errorCode`, and the `errorReport` payload.
   An operator without a Google Cloud project still sees every report here.
4. Forwards it through the configured reporter and answers `202` with an empty body and `cache-control: no-store`,
   whether or not forwarding succeeded.

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
| `GOOGLE_CLOUD_PROJECT` | unset | The Google Cloud project that receives forwarded reports; unset disables forwarding |

Credentials come from Application Default Credentials, never from OpenTag configuration:

- On Google-managed compute, use Workload Identity or the attached service account.
- Elsewhere, set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file mounted into the container. Do
  not commit the key, bake it into an image layer, or place it in `.env.example`.
- The identity needs the `roles/errorreporting.writer` role on the project.
- Enable the Error Reporting API (`clouderrorreporting.googleapis.com`) on the project.

The reporter is constructed on the first report, uses `reportMode: "always"` so a staging container reports
without `NODE_ENV=production`, and keeps the library's own console output to genuine errors such as missing
credentials. Restart the server after changing the variable.

When `GOOGLE_CLOUD_PROJECT` is unset the server logs one `info` line on the first report —
`Error reports are logged only; GOOGLE_CLOUD_PROJECT is not set` — and otherwise behaves identically: the relay
route, validation, rate limit, and `warn` log line are all present. Self-hosted deployments therefore run this
feature with no Google dependency at all.

## Failure path

Nothing in this path is allowed to affect the person using the product.

- The Web App sink swallows a rejected or throwing `fetch` and never writes to the console, so a reporting
  failure cannot produce a second error report.
- The CLI reports after it has already presented the failure and set its exit code; a slow or unreachable relay
  delays exit by at most three seconds and changes nothing else.
- The server answers `202` even when the Google Cloud library rejects the report; that failure is logged at
  `warn` as `Forwarding an error report to Google Cloud Error Reporting failed`.
- A report the schema rejects is the client's bug, answered with the shared `VALIDATION_ERROR` envelope, and is
  not forwarded.
