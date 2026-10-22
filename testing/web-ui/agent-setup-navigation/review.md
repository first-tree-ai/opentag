# Agent setup navigation change review

## Change inventory

- The account navigation rail remains mounted when an admitted Account enters Agent creation, preparation,
  messaging, and completion. Setup uses account navigation rather than the Agent-specific navigation.
- Embedded setup removes its header, including the brand, Account menu, and upper-right Back to agent/Set up later
  action. It shares the application content frame and retains one main landmark. Existing setup fields, step controls,
  and step order are preserved.
- First-time setup retains its full-screen presentation through Account admission. An Account-scoped tab hint
  preserves that presentation across reload and external authorization, and is retired on exit or sign-out.
- The brand mark links to All Agents. Completion remains visible until navigation; its primary action is
  **View agent** / **查看 Agent** and opens the exact Agent overview. No automatic return is introduced.
- An unfinished creation draft retains its step, name, destination, and runtime during navigation within the
  Account session. Reload and sign-out discard it. After creation, persisted Agent setup is restored by the Server.
- Pending creation survives navigation and blocks a duplicate submission. A late result refreshes Agent queries
  without redirecting an absent page. It clears only its submitted draft and preserves edits made while waiting.
- Optional layout-hint storage failures do not block resource navigation or local session cleanup after logout.
- Message catalogs, Web contract documentation, route/component tests, and browser acceptance evidence are updated.

## Independent code review

A separate read-only reviewer inspected the complete product diff, related sources, and tests. Initial review
independently reproduced two P2 issues. Both were fixed and independently rechecked:

| Finding | Resolution | Independent verification |
| --- | --- | --- |
| A late creation response deleted a newer draft, and remounting reset the submission lock | Store the pending attempt in Account session memory, associate it with its submitted draft, and let the active mount observe its outcome | Pending return cannot resubmit; late success preserves B; unchanged A advances to exact setup and is cleared; late failure reports to A without contaminating B |
| sessionStorage failure could interrupt resource navigation or logout before local session cleanup | Treat the layout marker as an optional hint and tolerate unavailable reads, writes, and removal | Storage removal rejection no longer throws; application regression verifies navigation and sign-out |

Final independent result: **5/5 edge validations passed; no remaining concrete actionable finding in this diff.**
The reviewer did not modify product files. Repository regression tests cover the durable behavior; temporary
reviewer tests exercised additional late-failure and unchanged-draft cases. `git diff --check` passed.

## Scope limits

The central New Agent step design, fields, runtime options, messaging integrations, and Server contracts are unchanged.
Draft retention is an in-memory navigation safeguard, not a saved-draft feature or background Agent creation.
Live Slack/Feishu OAuth installations and real model-provider requests require their external services and are
not established by this review. See [verification.md](verification.md) for browser and test results.
