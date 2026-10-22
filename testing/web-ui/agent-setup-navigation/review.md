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
  without redirecting an absent page. Name, runtime, Back, and Create are locked until the request settles; an active
  form always receives success or refusal, and a refused form unlocks for correction and retry.
- Optional layout-hint storage failures do not block resource navigation or local session cleanup after logout.
- Message catalogs, Web contract documentation, route/component tests, and browser acceptance evidence are updated.

## Independent code review

A separate read-only reviewer inspected the complete product diff, related sources, and tests. Initial review
independently reproduced two P2 issues. Both were fixed and independently rechecked:

| Finding | Resolution | Independent verification |
| --- | --- | --- |
| A late creation response deleted a newer draft, and remounting reset the submission lock | Store the pending attempt in Account session memory, associate it with its submitted draft, and let the active mount observe its outcome | Pending return cannot resubmit; late success preserves B; unchanged A advances to exact setup and is cleared; late failure reports to A without contaminating B |
| sessionStorage failure could interrupt resource navigation or logout before local session cleanup | Treat the layout marker as an optional hint and tolerate unavailable reads, writes, and removal | Storage removal rejection no longer throws; application regression verifies navigation and sign-out |

Initial independent result: **5/5 edge validations passed; no remaining concrete actionable finding at that review.**
The reviewer did not modify product files. Repository regression tests cover the durable behavior; temporary
reviewer tests exercised additional late-failure and unchanged-draft cases. `git diff --check` passed.

## PR review follow-up

The PR review identified a further P2 in the editable-pending behavior: editing on the same mount could suppress a
successful or refused outcome, re-enable Create, and leave the user unaware of the first Agent. Pending name/runtime
controls now use native disabled states and guarded change/submit handlers. The observer no longer filters results
by draft identity, so the active form always receives the result. Account-session pending state still fences duplicate
submissions across navigation, and departed observers remain inactive.

Independent read-only follow-up validation passed **4/4 combinations**: original/returning mount × success/refusal.
It attempts name/runtime changes, Back, and repeated form submission; verifies exact-Agent success and draft clearing;
and edits and successfully retries after refusal. No new concrete actionable finding was reported. This locked-form
contract supersedes the earlier editable-pending B-draft cases above.

CI also exposed two Agent Home tests that still expected the removed Back to agent button. Their assertions now
exercise All Agents in the account rail and reopening the exact Agent, matching the approved navigation behavior.

## Scope limits

The central New Agent step design, fields, runtime options, messaging integrations, and Server contracts are unchanged.
Draft retention is an in-memory navigation safeguard, not a saved-draft feature or background Agent creation.
Live Slack/Feishu OAuth installations and real model-provider requests require their external services and are
not established by this review. See [verification.md](verification.md) for browser and test results.
