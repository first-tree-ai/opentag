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
| Client connection/composition subset | 116 passed | Heartbeat acknowledgements, self-check and composition |
| Web changed-surface subset | 113 passed | Modern batching, legacy fallback, setup and immutable configuration |
| Final PostgreSQL suite | Pending final readback | Migration and persistence regression |

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
