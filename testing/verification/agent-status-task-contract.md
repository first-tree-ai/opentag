# Agent status, Task feedback and configuration identity

Supports [Runtime protocol](../../docs/system/runtime/runtime-protocol.md),
[Agent, Session and Computer model](../../docs/system/agent-session-computer-model.md),
[IM feedback](../../docs/system/messaging/im-feedback.md), and
[Web UI contract](../../docs/system/web/web-ui-contract.md).

## Scope

Issue #1215 implements the approved single-replica status pipeline using the existing registry,
keeps Task outcomes and custody semantics, and rejects replacement of configured identities.
An edited Agent with an empty Computer can finish binding at any revision; selecting its existing
Computer is a no-op. Model, permissions and profile edits and same-identity repair remain supported.

The approved database change is one `im_feedback_targets.message_format` column, with a non-null
`interactive_v1` default and a two-value check. The target format is frozen on insertion. Plain-text
failure feedback is selected for new targets only when `OPENTAG_IM_FEEDBACK_TEXT_ENABLED=true`;
the default is false. Existing interactive targets, unknown writes, admitted legacy Retry actions,
and authenticated workspace save/discard paths retain their existing recovery semantics.

## Automated regression

Validation uses Node 24.20.0 and pnpm 10.12.1. All providers and browser responses are synthetic;
PostgreSQL tests use isolated local migrated databases. No real message is replayed.

| Check | Result | Purpose |
| --- | --- | --- |
| `pnpm check` | Passed | Formatting, complexity ratchet, migration drift and documentation tree |
| `pnpm build` | Passed, 8 packages | Public exports and browser/server/CLI packaging |
| `pnpm typecheck` | Passed, 12 packages | Cross-package contract consumers |
| Shared unit suite | 812 passed | Schemas, public export snapshot and existing contracts |
| Server unit suite | 5,055 passed, 16 skipped, no failures | Status, configuration, feedback, credential/proxy and adjacent authority paths |
| Agent Runtime coverage | 823 passed; 100% statements, branches, functions and lines | Actual-work ownership, deadlines, epoch refresh and existing runtime behavior |
| CLI suite after base sync | 801 passed | CLI consumers and the updated Computer repair command |
| Full Client suite | 3,024 passed, 6 skipped | Runtime, local process boundaries, heartbeat acknowledgements and composition |
| Web changed-surface subset | 113 passed | Modern batching, legacy fallback, setup and immutable configuration |
| Full PostgreSQL suite | 1,399 passed; two timing/connection failures; both owning files passed in a serial 33-test rerun | Migration and persistence regression |

The broad suites ran on feature commit `5ab28aec5` over base `bfcde09f9`. After integrating
`main@69344cf3c`, affected validation passed: Server API/command/status tests (46), Web
Computer/setup/status tests (267), CLI tests (801), and the Context Tree integration cases (2).
Additional Context Tree checks passed: Server unit behavior (56), shared parsing (16) and Web settings (34).
A later setup-flow update at `main@773f31db6` was integrated and its affected seven-file Web subset
passed all 246 tests; Web build and type checks passed again.
Build, type checks and repository checks were rerun for that combination. No package manifest or
lockfile changed during the base sync.

The status tests cover 100 IDs with at most three SELECTs per snapshot, authorization failures,
one whole-snapshot retry on a connection-fence race, stale/duplicate self-check reports, monotonic
90-second offline detection, first-validation timeout, and generation isolation. PostgreSQL also
checks five complete 100-Agent status reads with 5,000 unrelated Agents, each below 500 ms, and
verifies the migrated column default and nullability.

Feedback tests cover Slack and Feishu text writes/readback, frozen format, legacy-card compatibility,
new Retry refusal, and idempotent completion of an already admitted Retry. Configuration tests cover
edited-unbound binding, same-target no-op, replacement rejection through compatibility APIs, and
legacy ownership/custody fixtures. Legacy-fixture helpers construct historical state only; production
services keep the new immutable-identity checks.

The full two-worker PostgreSQL run covered all 126 files (1,401 tests). One 4,096-Session/max-1-pool
stop hit the existing 30-second dispatch budget, and one Session-collaboration fixture could not
connect to local PostgreSQL within its connection timeout. Re-running both complete files serially
passed all 33 tests, without changing product deadlines or skipping cases. The migration cases and
new status batch cases passed in the broad run. The broad run itself is recorded as failed, not green.

The first broad Web run identified six outdated assertions/fixtures for the intentional behavior;
the owning seven-file, 113-test subset passed after correction. CI owns the complete final regression
matrix. No staging or production rollout, real-provider latency acceptance or multi-replica claim is
established by these checks.

## Browser validation

A headless Chromium run used a local Vite server and intercepted every API call. Its four Agents
show Ready, credential timeout, Computer offline, and the bounded first-validation initializing
state. There were no unexpected endpoints or page errors. Agent-list metadata negotiated version 1;
one status request covered all four Agents, with no per-Agent status fan-out.

| Width | Horizontal overflow | Evidence |
| --- | --- | --- |
| 320 px | None | [Screenshot](agent-status-task-contract/agents-320.png) |
| 390 px | None | [Screenshot](agent-status-task-contract/agents-390.png) |
| 768 px | None | [Screenshot](agent-status-task-contract/agents-768.png) |
| 1440 px | None | [Screenshot](agent-status-task-contract/agents-1440.png) |

The foreground 10.5-second observation increased batch requests from one to two. After hiding the
page, another 10.5 seconds left the count at two. Axe reported zero violations. Tab moved focus from
New Agent to the next interactive link. No new reusable block, theme value or CSS exception was added.
See the [synthetic readback](agent-status-task-contract/browser-check.json).

The browser run caught a Node-only hash import entering the shared browser entry through the Cloud
Runner module. Moving its public status schemas to a browser-safe module preserves existing public
exports and leaves `node:crypto` in the Node entry only; the rebuilt browser starts successfully.

## Coverage-job timing follow-up

The original PR head's remote Server coverage job timed out while testing repeated delivery
timeouts; the next case then failed because its timers were no longer mocked. The test
advanced 1.1 seconds before awaiting `runOnce()`, even though claim/reconcile SQL could finish and
arm the operation or grace timer after that advance had already ended.

The three timeout-counter cases now wait for delivery dispatch (or a completed recovery), then
yield the host event loop and advance the fake clock until the attempt settles. They retain all
counter, terminal-state and deduplication assertions. No product code, deadline, test timeout,
coverage threshold or worker-concurrency setting changed.

The complete delivery-worker file passed all 61 tests under V8 coverage. A four-file coverage run
at the configured four-worker concurrency passed all 171 cases. Existing remote coverage artifacts
for the original head also give 1,172/1,240 changed lines (94.52%) when evaluated offline; the
remote patch gate had stopped earlier because the Server measurement failed. This diagnostic is
not a green gate for a newer head.

After integrating `main@c48435a73` (product-regression documentation and messaging/notice UI
changes), the affected eight-file Web subset passed all 163 cases. There were no package-manifest
or lockfile changes. The next pushed head requires fresh CI and exact-head owner review.

The final follow-up also incorporates `main@1bca6c9a8`, which classifies inbound-receipt barriers as
expected deferrals. The same four-file coverage validation passed all 171 cases with that base and
the repository-compatible deferred-promise fixture. Root type checks passed; the edited Web
combination also built successfully.

## Review contract corrections

Admitted heartbeats now advance connection-fenced liveness before waiting for database authority.
Readiness and capability publication still wait for that authority. A blocked-database regression
checks both online classification and stale sweeping, and proves that completing persistence later
does not extend the receipt deadline. Self-check freshness also starts monotonically at registration
when no report has been accepted; continuing heartbeats and rejected reports cannot retain initial
Provider or messaging CLI readiness beyond 75 seconds.

Settings no longer offers Change bot, and same-App permission repair still sends reauthorization.
After a configured identity is disconnected, an owner-authorized setup read projects its retained
identity as blocked and offers a new Agent. Settings confirms setup authority before offering first
connection actions; it retains the Slack dialog instance during a successful binding refresh.
Never-activated generation-zero slots can still be cleared and creation resumed; their confirmation
copy explicitly differs from a configured identity's irreversible messaging disconnection.

The review correction subsets passed 193 Server and 197 Web cases. A native PostgreSQL smoke reused
the existing local server: both Providers exposed the disconnected identity to its owner, refused a
foreign owner with 404, and rolled every fixture back. A readback verified no probe users remained;
no temporary container was started. The script and machine-specific log stay outside the repository.

After integrating `main@d50c96e9d`, the affected Server subset passed all 278 cases and the Web
subset passed all 226. Build (8 packages), root type checks (12 packages) and repository checks
passed. There was no package-manifest or lockfile change. The disconnected Settings recovery also
passed a Chromium check at 320/390/768/1440 px: no replacement/connection controls, no horizontal
overflow, no unexpected API endpoints or page errors, and zero axe violations. See
[390 px](agent-status-task-contract/messaging-disconnected-390.png),
[1440 px](agent-status-task-contract/messaging-disconnected-1440.png), and the
[browser readback](agent-status-task-contract/review-browser.json).

Messaging dependency projection now follows the causal Server reason. Computer, runtime,
and initializing verdicts leave messaging unconfirmed without a messaging repair action, including
when an active binding exists. `im_not_connected` retains its neutral not-connected state. A
table-driven list/detail regression covers every `AgentStatusReason`, with both active-binding and
missing-binding cases for the higher-priority verdicts. The three owning Web files passed all 102
cases; Web build, root type checks and repository checks passed after this correction.

The final integration with `main@179783208` also passed the affected Web tests (221), Server
API/Context Tree tests (116), shared Context Tree/public-export tests (18), and coverage-gate
script tests (27). Root build, type checks and repository checks passed. Package manifests and
the lockfile did not change during this integration.

The subsequent paused-settings integration preserves readable stored channel state while paused,
without messaging recovery actions or writable controls. Computer offline still voids the other
dependency verdicts. Immutable replacement controls remain absent, and an empty paused Agent's
first-connection controls remain disabled.
The affected six-file Web subset passed 189 cases and the four-file Server subset passed 172.
After the conflict-resolution helper refactor, the two owning Web files passed 83 cases, including
paused plus offline precedence. Root build and type checks, the final Web build, and repository
checks passed. The existing PostgreSQL smoke also verified owner-only disconnected-identity reads
while paused and rolled its fixtures back. The four-width disconnected Settings browser check
passed again with fresh screenshots and zero overflow, unexpected endpoints, page errors or axe
violations. No package manifest or lockfile changed.

The older `db9e74d91` CI run passed 1,401 PostgreSQL cases and failed its 4,096-Session/max-1-pool
stop deadline case. That red result is not waived by these local checks; the next head needs a
fresh CI result and fresh review of all five corrected contracts.

## Retired-contract CI follow-up

The `8527f7fd9` remote matrix failed on retired replacement copy and tests: unused locale keys,
old identity-mismatch and disconnect text, a newly reachable setup link without a Router, and a
smoke assertion requiring the removed Change bot button. The catalogs, lifecycle documentation,
unbind comment and owning tests now describe original-identity repair or New Agent. The setup
fixture supplies a real memory Router and verifies that disconnecting offers New Agent without
channel choices. The paused smoke supplies the negotiated batch status fixture alongside the
existing synthetic binding observations and verifies replacement is absent.

The complete Web suite passed all 2,577 tests. The paused smoke passed for both Providers at
320/390/768/1440 px, including keyboard, overflow, axe, stopped-Feishu recovery, failed reads and
zero messaging writes. Nine paused-settings screenshots were refreshed; mobile Feishu and desktop
Slack evidence was visually reviewed.

That remote PostgreSQL run passed 1,418 cases and failed two integration assumptions. The stopped
Feishu fixture now uses its own Agent instead of replacing an already configured Slack identity.
Setup reads now select a current binding or retained disconnected identity in the original
owner-authorized snapshot, preserving the unchanged five-SELECT/eight-statement query budget and
terminal generation-zero slot semantics. Both complete owning PostgreSQL files passed all 25
tests at the normal two-worker concurrency using isolated databases on the existing local server.
The native active/paused owner-versus-foreign disconnected-identity smoke also passed and rolled
all fixtures back. No test container was created.

After integrating `main@a5d19e64f`, affected credential tests passed 28 Server and 40 Client cases;
Agent Runtime passed 824 cases with 100% statements, branches, functions and lines. Root build and
type checks passed before the final Server query correction; the final Server build/type checks
and affected three-file unit subset cover that correction. No manifest or lockfile changed. These
local results do not waive either failed remote run or establish a new-head CI result.
