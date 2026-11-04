# Paused messaging settings

Supports the [Web UI contract](../../docs/system/web/web-ui-contract.md#paused-agent-settings),
[Feishu lifecycle](../../docs/system/messaging/feishu-connection-lifecycle.md#paused-settings-reads), and
[Slack configuration contract](../../docs/system/messaging/slack-app-setup.md#paused-settings-reads).

## Reproduction and scope

On base `5bce111f1b1303afe4d094f6d83be419f3e464e9`, a real PostgreSQL fixture with an owned active
Slack binding could be read while its Agent was active. Changing only the Agent to `suspended` made the same
read fail with `404 IM_BINDING_NOT_FOUND`. The regression test failed at `assertCanManage` before the fix.

The fix admits the current owner of a non-deleted Agent on pure messaging reads. All existing mutation authority,
active-state, generation, attempt, cancellation, OAuth, and ticket checks remain in their original paths. There is
no schema, migration, retention, Agent lifecycle, Task, or external-channel change.

Other settings were inspected without modification: Agent detail/config and runtime-options authority use the
non-deleted owner scope; Skills and MCP list/configuration reads likewise exclude deleted Agents rather than
paused Agents. The existing page routing does not hide settings on pause.

## Local checks

- `pnpm build`, affected Server/Web type checks, and `pnpm check` passed.
- Server API/setup/startup tests: 93 passed; additional startup and Slack automatic-setup tests: 48 passed.
- Focused PostgreSQL `paused-messaging-settings.test.ts`: 9 passed. It covers active/paused reads, public HTTP DTOs,
  Account suspension, deleted/foreign/transferred Agent rejection, saved Feishu candidate observation, active-only
  management, no Provider calls or persistence changes, passive readiness callbacks, and a controlled transfer with
  two PostgreSQL connections retaining one authorized snapshot.
- PostgreSQL `slack-custom-configuration.test.ts`: 15 passed. Feishu drain and Slack setup-authority regressions passed
  in the expanded run, including stale callback/generation/Account and suspended-Agent fences.
- Web messaging/presentation tests: 50 passed; Agent query, settings layout, and detail tests: 30 passed.
- Browser smoke passed with a local fixture database and dedicated Server/Web processes. Agent creation, pause,
  authentication, and the unbound paused GET use the real application. Channel binding/handoff/configuration
  observations are supplied as browser fixtures; no real Feishu or Slack account is contacted. PostgreSQL service
  tests above provide the actual authorization/query evidence.

The expanded three-file PostgreSQL run completed with 124 passing and 5 failing tests in the pre-existing
`im-binding.test.ts` delivery/history/placement cases. A clean checkout of the exact base, with the same locked
dependencies and the five failing cases selected, reproduced the history timeout and pending-placement deadlock
(2 failed, 3 passed). A first candidate recheck was blocked during PostgreSQL startup, before any test ran.
After integrating `bfcde09f9f7aec9d469fa4d00ec8dee9de403183`, the current-base binding/settings/custom-Slack run
finished with 130 passed and one delivery-admission timeout failure, followed by a worker cleanup rejection. That
single failing case passed when selected alone on both the candidate and clean main. The later
`260cdc370148048080da868f3cc8cf19602296af` base update changes documentation only. Server build/type checks and
repository checks passed after the runtime base update; the documentation-only merge was checked too. The full
expanded suite is not reported green; complete regression remains a CI gate.

## Browser evidence

Both Providers were checked in Simplified Chinese at 320, 390, 768, and 1440 pixels. The run verifies the stored
channel identity/state, paused read-only explanation, disabled trigger/connection/credential controls, readable
Slack details, settings overview and Agent Messaging row, and an unavailable binding read that never becomes a
missing or successful connection. Keyboard Enter opens Slack details, Escape closes them, axe finds no violations,
page-level horizontal overflow is absent, and no messaging mutation request is issued. Expected error telemetry
from the injected unavailable read is allowed explicitly.

| Width | Feishu | Slack |
| --- | --- | --- |
| 320 | [Screenshot](../assets/paused-messaging-settings/feishu-320.png) | [Screenshot](../assets/paused-messaging-settings/slack-320.png) |
| 390 | [Screenshot](../assets/paused-messaging-settings/feishu-390.png) | [Screenshot](../assets/paused-messaging-settings/slack-390.png) |
| 768 | [Screenshot](../assets/paused-messaging-settings/feishu-768.png) | [Screenshot](../assets/paused-messaging-settings/slack-768.png) |
| 1440 | [Screenshot](../assets/paused-messaging-settings/feishu-1440.png) | [Screenshot](../assets/paused-messaging-settings/slack-1440.png) |

The [stopped Feishu binding at 390px](../assets/paused-messaging-settings/feishu-error-390.png) retains its public
credential-refusal explanation and a disabled **Reconnect** button with its label, without an operation spinner.
All nine screenshots are refreshed after integration of main `41d09f72b45cdacb758f0ef8f6c0469be625bcc2`.

The latest browser run reuses the existing local PostgreSQL instance with a disposable fixture database and
dedicated Server/Web processes. The fixture database is removed after the run; the existing database and instance
are preserved. An earlier run used a distinct Compose project: wildcard PostgreSQL publishing could not serve host
queries on this Docker Desktop host, while explicit loopback publishing succeeded. No production environment,
live authorization, message delivery, deployment, or post-deployment acceptance was exercised.

The subsequent base `cbacb543f9289d2b2b9ba4fb7b86202d2ec20282` includes the settled paused-settings text and
Computer connection-copy changes. The paused-settings section is consolidated as implemented, with its Planned
marker removed; the Cloud type-step decision is preserved. Manifests and the lockfile are unchanged. This merge
is checked with affected package type checks/builds and the focused messaging/presentation tests.

## Embedded setup-read race fixtures

The embedded setup projection tests use one PGlite connection. Their pause fixture opts into holding a captured
result after its read-only transaction commits, before the service receives that result. This lets the controlled
writer advance the saved attempt or transfer ownership without queuing behind the same embedded connection.
The default pause mode still retains its transaction for the other drain and cancellation tests. Public attempt
and Agent read authority tests observe `assertCanRead`; final authority revalidation and all existing assertions
remain in place. The Agent setup projection suite passes all 72 cases, and the default-mode cancellation/drain
regressions pass all three selected cases. This fixture adjustment supplements the independent-connection
PostgreSQL snapshot evidence above; it does not replace it or change production read/write behavior.

With that fixture adjustment, `node scripts/unit-coverage.mjs --project server` completes with 5,052 tests passed,
16 skipped, zero failures, zero retries, and zero flaky tests. Server line coverage is 90.75%. The Server-only patch
coverage check uses the repository gate at its 80% threshold and passes with 139/147 changed executable lines
covered (94.56%). The eight uncovered Slack-view lines retain the real PostgreSQL configuration evidence above.

## Web regression catalogue integration

The main update through `22a521a3d17b9a20cfa37e60e66e22647f58a72d` adds the Web product regression
catalogue, simplifies setup styling and copy, and permits Context Tree selection without first pausing an Agent.
The catalogue's former paused-messaging 404 exception is removed and replaced by ST-22, which links the existing
read-only messaging checks and this evidence. No package manifest or lockfile changes in this base update.

After integration, nine focused Web files pass all 289 tests covering messaging, paused presentation, setup,
layout, computer choice, Context Tree settings, and catalogue ordering. The three affected Server Context Tree
unit files pass all 56 tests. Shared and Web builds, Server/Web type checks, and repository checks pass. Browser
evidence is refreshed again with the subsequent Feishu integration below; complete new-head regression remains
a CI gate.

## Feishu connection-refusal integration

The main update through `41d09f72b45cdacb758f0ef8f6c0469be625bcc2` adds public reasons for stopped Feishu
connections. Its summary projection remains inside the authorized read-only snapshot. The import conflict is
resolved with the operators still used after both query extractions; the existing fenced connection-failure
handling and active-only messaging mutations remain intact. There is no manifest, lockfile, or schema change.

A combined Web regression exposed a paused recovery button displaying a busy state because read-only authority
was folded into operation state. The button now handles these independently: pause disables it while retaining its
**Reconnect** label, and only actual work displays progress. Active recovery stays available. The unit and browser
cases check both the failure explanation and disabled reconnection without issuing a messaging mutation.

Ten focused Web files pass all 167 tests. Binding API, Feishu adapter, and failure-classification unit tests pass all
85 cases. The paused-settings and dead-binding PostgreSQL files pass all 18 cases, including the new paused
connection-refusal read and unchanged rejection of management authority. The existing two-worker integration
setting and enabled resource reaper are retained; both temporary PostgreSQL containers are removed. Shared,
Server, and Web builds, Server/Web type checks, repository checks, and the refreshed browser smoke pass. The
complete new-head CI matrix is still required before merge.
