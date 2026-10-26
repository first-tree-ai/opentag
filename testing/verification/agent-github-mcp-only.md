# Agent GitHub access through MCP

Product contract: [GitHub platform integration](../../docs/system/capabilities/github-platform-integration.md) and [Context Tree integration](../../docs/system/capabilities/context-tree-integration.md).

## Required regression coverage

- Ordinary Local/Cloud executions receive no GitHub binding, handle, token, git/gh shim or helper. A retained ordinary handle is rejected by the broker.
- MCP tools and IM credentials remain available; system instructions direct GitHub work to the Agent's MCP connector.
- Context Tree requires a negotiated service, active Account authorization, current selection and matching parent execution/placement/Sandbox.
- Dedicated Git transport rejects REST, other repositories, other branches, deletion and multiple-ref pushes before upstream forwarding.
- Parent close, revocation, caller cancellation and deadlines stop Context Tree commands without replaying writes or discarding unpublished edits. Cloud tests use the pinned CLI with detached Git descendants, including a child that ignores SIGTERM.
- A reused Local Provider Runtime configures each new execution; the command client reads the current manifest instead of using a stale socket. A removed manifest fails closed.
- The pinned CLI can sync a local fixture, prepare an isolated write, and publish from a later execution. Routing hints contain no credential and are removed on publication/abort.
- Server settings create/connect/verify, OAuth callbacks, refresh, and repository discovery remain supported.

## Staging acceptance

Pending deployment of this change; earlier MCP acceptance does not validate this boundary.

For both Local and Cloud Agents, inspect the effective provider environment, use the configured GitHub MCP to read and write a bounded test Issue/PR, then verify Context Tree sync, isolated editing, later-turn publication, missing authorization, changed selection and execution cancellation. Account disconnect and MCP disconnect must affect their own authorization paths. Verify live identity and resulting commit separately from tool success.

Deploy Server compatibility first, then Client/Runner. Preserve serving availability throughout rollout. Do not report staging PASS from local fixtures.

## Local verification (2026-10-26)

- Repository checks and full workspace build passed.
- Shared/Client/Server type checks passed; workspace consumer type checks were also exercised.
- Client unit suite: 2,803 passed, 6 skipped.
- Server unit suite: 4,262 passed, 16 skipped; the final Git scope/adapter/real-Git regressions also passed (72 passed, one Linux-only transport skip).
- PostgreSQL credential integration: 22 passed, including authoritative Context Tree selection.
- IM binding PostgreSQL integration: 106 passed. Retained-Turn recovery waits for the old owner's dispatch-release transaction before testing expiry and owner restart.
- Shared unit suite: 773 passed; the added public exports were then checked against the updated snapshot.
- Account GitHub settings and actions: 39 passed.
- Agent Runtime: 773 passed; statements, branches, functions and lines all reached 100%.
- Targeted Client command, bridge, credential and runtime regressions passed. The real pinned CLI completed synchronization, isolated editing and publication from a later execution through both Local execution and the Cloud worker source, using only local Git fixtures.
- GitHub Account browser smoke: 17 passed, including both locales and the supported responsive layouts. The local run used an isolated PostgreSQL project with a test-only stdio TCP forward because Docker Desktop port forwarding was unavailable.
- The Cloud worker cancellation probe also passed in a Linux Node container with a detached Git child that ignores SIGTERM: the child had stopped and no subsequent filesystem mutation occurred.
- Deployed Local/Cloud and live GitHub acceptance remain pending.
