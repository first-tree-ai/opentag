# Custom Slack Apps: verification and acceptance

Test and acceptance material for [Custom Slack Apps](../../docs/system/messaging/custom-slack-apps.md).

Initial acceptance recorded on 2026-10-13 at product source `06f548b2d017a76865001c58ed45f53ce525c360`;
implementation base: `75e97ca88bec2c69749347a8674489386c10768a`. Later Web-only onboarding refinements followed staging QA;
the dated evidence below is a historical snapshot.

## Code review and cleanup

Review was a separate pass in the same chat over the complete diff and call chains; it was not a second reviewer or an
external review service. Findings were repaired before the final validation. No remaining concrete blocking defect was
identified within that scope.

| Finding | Resolution |
| --- | --- |
| P2: official recovery appeared even when OAuth was unavailable | Gate on explicit `false`; test true, false and omitted availability. |
| P2: URL challenge hid the return-to-Slack link before Save Changes | Keep the link while identity is pending and explain Save Changes before sending a DM. |
| P3: ready dialogs kept polling every two seconds | Poll only an open, pending, nonediting dialog; stop when ready. |
| Duplicate scopes check | Each configuration entry validates scopes once. |
| Repeated installation identity comparison inside the transaction | Remove the extra parameter/branch; retain same-token identity checks and binding/generation compare-and-set. Add concurrent OAuth replacement regression. |

Review cleanup reduced product source by 12 net lines and added 89 net test lines relative to `9d9ab4c4`. It did not add
complexity exceptions or weaken credential, signature, authorization, isolation, or concurrency checks. A live ready
dialog observation at `09e4e538` recorded one configuration GET and zero additional GETs over 11.60 seconds; the last Web
compatibility repair did not change polling code.

## Automated validation and revision boundaries

| Check | Actual target and result |
| --- | --- |
| `pnpm check` / `pnpm build` / `pnpm typecheck` | `06f548b2`: pass; typecheck 12/12, complexity ratchet 127 warnings / 42 improvements with unchanged budgets. |
| `pnpm test` | `09e4e538`: 628 script tests + 9,672 workspace tests pass (12/12 tasks, 10 cached). |
| Final affected Web regression | `06f548b2`: 5 files, 71 tests pass, including omitted availability and old-server recovery. |
| PostgreSQL integration | `06f548b2`: 55 files, 707 tests pass with default `maxWorkers=2`, 175.66 seconds. |
| Runtime coverage | `5fa54a3e`: 28 files, 580 tests pass; statements/branches/functions/lines all 100%. Client runtime source did not change afterward. |

`06f548b2` differs from `09e4e538` only in the Web availability condition and its regression test. The full unit result
belongs to its actual target; the final 71 Web tests are not added to the old total to imply a new full-suite run.

An earlier integration run at `09e4e538` passed 705/707: an unchanged history-cap case timed out at five seconds, followed
by a Feishu recall deadlock. The complete failed file then passed 100/100 unchanged, followed by the final full 707/707
pass. Timeouts, assertions, worker configuration and skip conditions were not relaxed. The initial root cause remains
unproven; parallel load and work surviving the timed-out case are a hypothesis. A first review typecheck also caught a
new test's incorrect method name; it was corrected before completed validation. Failed/interrupted logs are retained in
the task-local evidence directory rather than counted as passes.

## Real Slack acceptance

Tier: **focused-local**, using the logged-in **Local-team** and two explicitly authorized new Apps:
`slack-custom-a-1012` and `slack-custom-b-1012`. App creation, install, configuration, message sending and approval actions
used Computer Use. Both installed the same 18 scopes. Model calls used explicitly selected **Codex `gpt-6.1-sol`**,
authorized by the user because Gemini 3.8 Flash was unavailable. The actual provider turn records confirmed the model and
`on-request` approvals; permanent command permissions were not widened.

Live ingress/reply/restoration/isolation/approval scenarios ran at `5fa54a3e`; the Events copy was updated at `8ce56c39`,
and A's post-restart reply plus the final guide wording were checked at `9d9ab4c4`. The latest recovery UI was checked at
`06f548b2`. Original live results are not represented as a repeat on the later review source.

| Scenario | Observed result |
| --- | --- |
| Create before messaging | A was created without Computer or IM binding, then connected to the isolated Computer. |
| Independent App setup | Both Apps created and installed from the product's prefilled manifest; Events Verified and Save Changes completed. |
| A DM | Request `1791857114.008369`; reply `1791857129.711449`: `APP-A-OK-1013`. |
| B DM | Request `1791857390.070949`; reply `1791857403.961069`: `APP-B-OK-1013`. |
| Cross-App Token rejection | A's Token was rejected for B; B's installation, binding, generation and Session were preserved. |
| Secret-only restoration | B generation 1→2; blank Token preserved; same binding/DM Session; `APP-B-RESTORED-1013` at `1791857507.445349`. |
| Token-only restoration | B generation 2→3 after restart; blank Secret preserved; subsequent signed messages and approval succeeded. |
| Same Team, same private channel | A replied `CHANNEL-A-1013` at `1791857747.145289`; B replied `CHANNEL-B-1013` at `1791857761.937909`; independent Sessions and projections. |
| Other Bots and receive mode | B in `mention_only` retained history without deliveries; A in `all_message` accepted B's ambient message, completed silently, and did not loop. B restored to `all_message`. |
| Native Slack approval | Public read-only `curl --head --max-time 10 https://example.com`, approved through existing Interactivity; B replied `APPROVAL-B-OK-1013` at `1791858176.660779`. |
| Restart persistence | Original credentials survived restart; A replied `APP-A-PERSISTED-1013` at `1791858722.187919`. |

Restoration reused the same valid credential values; it did **not** rotate Slack secrets or revoke a live Token. This
was local acceptance, not deployment. Test Apps, Agents, private channel, database, foreground client and temporary
callback service were retained for inspection. Admin app-approval policy, Marketplace/Enterprise installs, credential
rotation, and individual file/reaction external operations were outside scope. OAuth and Feishu compatibility were
covered by local regression, not new external reauthorization.

Only inspected test Web screenshots are included below. Original Slack screenshots, sanitized event/delivery/model
records, frozen build hashes and complete logs remain in the task-local evidence archive. No credential material or
private environment files are attached.

## UI evidence

The creation screenshot is the original live product guide; the ready-settings screenshot is from `06f548b2`.
Manual product acceptance used desktop layouts. Dedicated mobile-width and screen-reader acceptance was not performed;
older responsive prototype checks do not count as current product validation. Components reuse existing Dialog, Input,
Button and Collapsible primitives; no new theme value or CSS exception was introduced.

![Creation guide with two empty credential fields](../assets/custom-slack-app/creation-guide.png)

![Ready custom App settings without unavailable official OAuth](../assets/custom-slack-app/ready-settings.png)
