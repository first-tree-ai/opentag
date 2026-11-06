# Web product regression catalogue

The product behaviours a regression run of the openTag Web product checks, one row per behaviour. It supports the
[Web UI contract](../../docs/system/web/web-ui-contract.md), which states the rules these cases check.

## How to use it

- Every release runs both **Core** and **Edge** cases. Core cases also support focused checks after a change to the area.
- **Edge** cases cover recovery paths, rare states, and layout extremes.
- Unless a row says otherwise, check it in both Chinese and English, at 320, 390, 768, and 1440px, with no
  page-level horizontal overflow (see [Languages and widths](#languages-and-widths)).
- The **Verified today** column names where the behaviour is already checked automatically:
  - `smoke:` a browser smoke spec under [`e2e/tests`](../../e2e/tests).
  - `unit:` a Web unit test under `apps/web/src`.
  - `sweep` the local signed-in page sweep: every reachable page at the four widths in both languages, with
    screenshots, accessibility checks, overflow, and console or server errors.
  - `connect Cnn` a scenario in the local computer-connect harness. It runs the real connect command on a fresh
    container machine and judges the outcome. Those scenarios are listed in [Computers and the connect
    command](#computers-and-the-connect-command).
  - `manual` no automated check yet.

The sweep and the connect harness run locally and are not part of this repository; their scenarios are described here
so the cases stay readable without them.

When a change fixes a product issue, add or update at least one row here, and its automated check, in the same pull
request. Keep one row per behaviour, not one per screenshot or width.

## Agent list

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| AL-01 | List shows every Agent | Open All Agents with several Agents | Each Agent shows its name, messaging app, and one status; the count line matches | Core | smoke: `app.spec.ts`; unit: `features/agents/agents-page.test.tsx`; sweep |
| AL-02 | Running Task count | Have an Agent with running Tasks | Its row shows how many Tasks are running | Core | unit: `features/agents/agents-page.test.tsx` |
| AL-03 | One action per fixable row | Agents with setup unfinished, Computer offline, messaging needing permissions | Each fixable row offers exactly one link to where it gets fixed (Continue setup, Restore connection, Update permissions); a finished Agent whose messaging credential check failed offers Reconnect channel, never Continue setup; a paused Agent or a timed-out check offers none | Core | unit: `features/agents/agent-presentation.test.ts` |
| AL-03a | Temporary provider trouble is not a failed credential check | With an Agent ready, make the messaging provider unreachable from its Computer (block DNS or the network) until the next check; separately, revoke the Agent's bot credential; also run several Bots on one Computer through a check cycle | Blocked provider: row reads "Messaging provider unreachable" with no action and returns to Ready on the next check after access returns. Revoked credential: row reads "Messaging credential check failed" with Reconnect channel, and stays so if the provider then becomes unreachable. Several Bots: all stay Ready | Core | unit: `server __tests__/provider-cli-reconcile-owner.test.ts`, `server __tests__/agent-status.test.ts`, `features/agents/agent-presentation.test.ts` |
| AL-04 | Runtime needs sign-in | Computer reports the Agent's Claude Code or Codex as signed out | Row shows "{runtime} sign-in required" and one Sign in link that opens setup with the sign-in steps shown | Core | unit: `__tests__/agent-computers.test.tsx` |
| AL-05 | Status stays steady while refreshing | Load the list right after the Server or a Computer restarts, then leave it open through background refreshes | A row with no answer yet reads "Checking" (never Ready) until its first answer; after that, statuses do not flicker or reorder between refreshes | Edge | unit: `features/agents/agents-page.test.tsx`, `features/agents/agent-list-status.test.ts` |
| AL-06 | Uppercase and Chinese names | Agents named, for example, "Atlas研发" | Names show as typed in the list and on the Agent page | Core | manual |
| AL-07 | Long names | An Agent with a long name | Name wraps or truncates inside its row and in the Agent switcher; no overflow | Edge | smoke: `navigation-polish.spec.ts` |
| AL-08 | Known messaging problem while a runtime check runs | Agent whose binding needs new permissions (or failed, or was turned off) while its runtime check is still running | The status shows the messaging problem and its action (Update permissions), not Checking; a confirmed runtime problem still comes first; an unreadable binding still reads Checking | Core | unit: `features/agents/agent-model.test.ts` |
| AL-09 | Waiting Task count | Stop an Agent's Computer, then @-mention the Agent in two separate group threads; send a second message in one thread; send an unaddressed message in a group the Agent only overhears | The row and the Agent home read "2 tasks waiting" ("2 个任务等待中") beside the offline status; repeated messages in a Session and the overheard message add nothing. After the Computer returns and the messages are taken, the line goes away | Core | unit: `features/agent-list-order.test.ts`; integration: `agent-queued-task-count.test.ts` |

## Agent setup

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| AS-01 | First Agent, Local | Fresh Account: choose Local, keep the default name, pick a runtime, create | Agent is created and setup moves to Prepare this computer; the Agent appears in the list | Core | smoke: `app.spec.ts`, `browser-smoke.spec.ts`; unit: `__tests__/agent-setup-boundary.test.tsx` |
| AS-02 | Agent type is fixed once chosen | Continue past the Local/Cloud choice | No in-flow Back; the choice can't be changed mid-setup | Core | unit: `onboarding-v2/steps.test.tsx` |
| AS-03 | One exit to the Agent list | On each setup step after creation, and on completion, use Back to Agents | Lands on the Agent list; the unfinished Agent offers Continue setup | Core | unit: `__tests__/agent-setup-boundary.test.tsx`, `onboarding-v2/agent-setup-page.test.tsx` |
| AS-04 | Logo returns to the list | After creation, select the openTag logo | Lands on the Agent list. First-time creation (no Agent yet) offers no exit except signing out | Core | unit: `__tests__/agent-setup-boundary.test.tsx` |
| AS-05 | Header on phones | First-time full-screen setup header (an Account with no Agents yet) at 390 and 320px | Logo shows the mark only; Back to Agents and the Account menu stay on one row at the top right | Edge | manual |
| AS-06 | Name rule is stated up front | Open the name field before typing | Hint states the allowed characters (letters in either case, digits, Chinese, hyphens; no leading hyphen) | Core | unit: `onboarding-v2/steps.test.tsx` |
| AS-07 | Name refused | Type a name with a space or punctuation, or one starting with a hyphen | Short error "The name has characters that aren't allowed"; Create is refused | Core | unit: `onboarding-v2/steps.test.tsx`, `onboarding-v2/flow.test.ts` |
| AS-08 | Name length | 64 letters, then 65; 21 Chinese characters, then 22 | 64 letters and 21 Chinese characters are accepted; one more shows the length error while typing, before Create | Edge | unit: `onboarding-v2/flow.test.ts`, `onboarding-v2/steps.test.tsx` |
| AS-09 | Name taken, any case | Create "Atlas" when "atlas" exists | Refused with "An Agent with this name already exists. Names aren't case-sensitive."; offers to open the existing Agent | Core | unit: `__tests__/agent-setup-boundary.test.tsx`, `onboarding-v2/creation-error-message.test.ts` |
| AS-10 | Runtime choice is called an Agent | Creation step with Local | Choice is labelled "Agent to use"; no "Runtime" in the creation copy | Core | unit: `onboarding-v2/steps.test.tsx` |
| AS-11 | Cloud availability | Deployment with Cloud off, still checking, or failed to answer | Cloud card says why it is unavailable or checking; a failed read offers Try again; Local stays selectable | Edge | unit: `onboarding-v2/steps.test.tsx` (checking and failed states are unit-only; a manual run can check Cloud off) |
| AS-12 | Connect this computer | Prepare this computer with no Computer bound | The window shows exactly what Copy copies: one leading line for an Agent, then the connect command, which also runs as-is in a terminal (including macOS zsh); the page waits and continues once the Computer connects | Core | smoke: `computer-connection.spec.ts`; unit: `features/computer-connect/computer-connect.test.tsx`; connect C21 |
| AS-13 | Choose among existing Computers | Account with several Computers, none bound | Lists them without creating a new connection; binding happens only after the user chooses | Edge | smoke: `computer-connection.spec.ts` |
| AS-14 | Runtime sign-in steps | Runtime row reports signed out | Sign in expands terminal steps for that computer (`claude` then `/login`, or `codex login`) with copyable commands; Check again follows; the row number stays aligned with its title | Core | unit: `onboarding-v2/runtime-sign-in.test.tsx`, `onboarding-v2/agent-setup-page.test.tsx` |
| AS-15 | Runtime install and unavailable | Runtime row reports not installed or unavailable | Row names the state and the next step; Check again re-reads it | Edge | unit: `onboarding-v2/agent-setup-page.test.tsx` |
| AS-16 | Connect messaging, Lark | Choose Lark and scan the QR code | Setup observes the binding and completes; View agent opens the Agent | Core | unit: `onboarding-v2/agent-setup-page.test.tsx`; smoke: `app.spec.ts` (setup Lab) |
| AS-17 | Connect messaging, Slack | Choose Slack: OAuth, or manual setup with the prefilled App manifest | Binding completes; manual setup shows the exact prefilled bot name | Core | unit: `onboarding-v2/slack-custom-app-entry.test.tsx` |
| AS-18 | Messaging recovery | A binding that needs new permissions or failed | Recovery title, the reason, and the recovery action; disconnect keeps its confirmation | Edge | unit: `onboarding-v2/agent-setup-page.test.tsx` |
| AS-19 | Completion | Finish setup in full-screen and embedded layouts | Completed progress labels become quiet; one open composition contains the ready heading, actual Bot identity and conversation entry beside secondary View agent. No configuration-card footer, starter request form, tutorial or automatic message is added. View agent opens the exact Agent; global navigation still exits to All Agents | Core | unit: `onboarding-v2/completion-handoff.test.tsx`, `onboarding-v2/agent-setup-page.test.tsx`, `__tests__/agent-setup-boundary.test.tsx`; manual layout |
| AS-20 | Draft survives a visit away | Fill name and runtime, go to All Agents, return to New Agent | Draft is restored; a pending creation stays pending and disabled | Edge | unit: `__tests__/agent-setup-boundary.test.tsx` (the pending creation is unit-only; a manual run can check the restored draft) |
| AS-21 | Lark QR scans and expires | On a public HTTPS deployment, connect Lark and scan the QR code with the Lark or Feishu app; then scan a code from an attempt that was cancelled or expired | The symbol encodes `<public URL>/q/<token>` and is visibly sparse; the scan reaches the app-creation page and setup completes; Open link works from a desktop browser; the old code shows the plain "no longer works" page. On a localhost deployment the symbol encodes the full launcher URL | Core | unit: `__tests__/feishu-qr-link.test.ts`; manual: phone scan |
| AS-22 | Provider conversation destination | With an authorized connected Slack or Feishu test App, start outside the Bot chat and select the completion entry; record any browser landing and system confirmation | Entry uses the verified App/Team identity and the documented provider URL. Acceptance requires the correct workspace and Bot private conversation with usable input; a profile, search, retained Files pane or App focus alone does not pass. Opening sends no message | Core | unit: `onboarding-v2/completion-handoff.test.tsx` (URL selection); manual native destination |
| AS-23 | Short entry recovery | Expand the completion help, then request Copy Bot name; exercise clipboard refusal through a controlled fixture | Help is folded initially and reveals only the real-name search/copy route. Nothing copies automatically; success copies the exact name, and refusal explains manual copying. The conversation and management actions remain available | Edge | unit: `onboarding-v2/completion-handoff.test.tsx`; manual disclosure and copy; clipboard refusal is fixture-only |
| AS-24 | Loading, unavailable and stale identity | Use controlled completion fixtures for a pending/failed binding read, another Agent/provider/binding/generation, and a late old response | Management remains usable while loading or unavailable. Failed/mismatched reads expose no previous Bot entry; a late response cannot replace the new binding's identity | Edge | unit: `onboarding-v2/completion-handoff.test.tsx`; controlled fixtures |
| AS-25 | Verified binding with no display name | Use a valid binding fixture with a null, empty or whitespace name, then a nameless unknown-brand fixture | A verified supported App entry and Connected state remain, with a generic Bot label and no invented name/search/copy. Without a supported URL or name, guidance says the name is unavailable; this is distinct from a failed binding read | Edge | unit: `onboarding-v2/completion-handoff.test.tsx`; controlled fixtures |
| AS-26 | Unknown provider brand | Use a ready Lark or unknown-brand binding with its real Bot name | No equivalent URL is inferred from locale, App ID or ID prefix. The real-name search/copy route is visible and management stays secondary | Edge | unit: `onboarding-v2/completion-handoff.test.tsx`; controlled fixtures |
| AS-27 | Completion on phones and with long names | Inspect full-screen and embedded completion at 320, 390 and 1440px in both languages with long Agent/Bot names; traverse controls by keyboard | Complete names wrap without horizontal overflow; primary and secondary actions stack on phones, retain touch targets of at least 44px and show keyboard focus. Help, copied/failed feedback and exact navigation remain readable and reachable | Edge | unit: `onboarding-v2/completion-handoff.test.tsx` (complete name and copy); manual layout and keyboard |
| AS-28 | Explicit re-board completion | Use ready, pending and failed completion-report fixtures | Finish re-board is explicit, pending is disabled and a failure offers retry. No Bot identity read or conversation entry is mounted during this review; no automatic navigation or provider message is sent | Edge | unit: `onboarding-v2/completion-handoff.test.tsx`, `onboarding-v2/agent-setup-page.test.tsx`; controlled fixtures |
| AS-29 | Handoff needs attention versus pending | Use handoff fixtures with preparing, checking credentials and needs-attention observations, including a reasoned failure | Genuine pending work keeps the Checking status and waiting animation. A needs-attention result says Needs attention without that animation, while retaining its reason and existing recovery action. Neither state claims that activation or message delivery succeeded | Edge | unit: `onboarding-v2/agent-setup-page-recovery.test.tsx`; manual status transition |

## Agent home and schedules

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| AH-01 | Home sections in order | Open an Agent | Usage, status, Schedules, Tasks, in that order | Core | smoke: `app.spec.ts`; sweep |
| AH-02 | Task table alignment | Agent home with Tasks | Section title, column headers, and cell text share one left edge; View all aligns right | Edge | manual |
| AH-03 | Schedule row | Agent with enabled schedules | Each row: name as a heading, Pause, and one line with the rule in words, the next time, and the last time; no label for the default state | Core | unit: `features/agents/agent-schedules-section.test.tsx` |
| AH-04 | Rules in words | Schedules for weekdays, specific days, a day of the month, a day range, hourly windows, fixed intervals | Rules read in words in both languages (for example "Every weekday at 9:00", "Monthly on days 28–31 at 18:00"); unphraseable cron, including minute steps that don't divide an hour, show as written | Core | unit: `features/agents/schedule-rule.test.ts` |
| AH-05 | Short times | Any schedule | Month, day, weekday, and unpadded hour; the zone is named only when it differs from the reader's | Edge | unit: `features/agents/schedule-rule.test.ts` |
| AH-06 | Missed last run | Last run didn't happen (Computer offline, Agent paused, missed, skipped) | Last run says why in plain terms, in the danger colour; an unconfirmed run says so in the warning colour | Core | unit: `features/agents/agent-schedules-section.test.tsx` |
| AH-07 | Schedule details | Open a schedule | Shows only where it posts (for example "Lark · thread"), the zone if different, one note after a failed or unconfirmed run, the full task, and Delete; no internal IDs or reason codes | Core | unit: `features/agents/agent-schedules-section.test.tsx` |
| AH-08 | Pause, resume, delete a schedule | Pause, then Resume; open details and Delete | State updates with the observed revision; Paused label appears only while paused; delete asks for confirmation | Core | unit: `features/agents/agent-schedules-section.test.tsx` |
| AH-09 | Schedules on phones | Schedules at 390 and 320px | Pause or Resume stays on each title row; long names wrap in the title | Edge | manual |
| AH-10 | Deep-linked schedule | An Agent with more schedules than one page; open a link from IM to a schedule beyond the first page, and one to a schedule that no longer exists | That schedule opens with its details, even outside the first page; an inaccessible link says so without task content | Edge | unit: `features/agents/agent-schedules-section.test.tsx` |
| AH-11 | Running work on the status card | Agent with two running Tasks; then an idle Agent that isn't ready | The status card's first row, Work, reads the same line as the list row ("2 tasks running"); the idle Agent gets no Work row | Core | unit: `features/agents/agent-detail-page.test.tsx` |

## Agent settings

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| ST-01 | Settings persist | Change a setting and reload | Change is kept | Core | smoke: `app.spec.ts`; unit: `features/agents/agent-settings/general-config-form.test.tsx` |
| ST-02 | Messaging settings | Open messaging for a bound, unbound, and needing-permissions Agent | Shows the connection, its state, and the matching action (connect, update permissions, reconnect) | Core | unit: `__tests__/agent-messaging.test.tsx` |
| ST-03 | Computer settings | Agent with an online, offline, and unbound Computer | Shows the Computer and its runtime state; offline offers connection recovery; another Computer can be connected without moving the Agent | Core | smoke: `computer-connection.spec.ts`; unit: `features/agents/agent-settings/agent-computer-settings.test.tsx` |
| ST-04 | Model and runtime test | Choose a model, save, run the connection test | Test passes, fails with a sanitized reason, or reports stale settings; leaving cancels it | Core | smoke: `runtime-test.spec.ts`; unit: `features/agents/agent-settings/runtime-test-action.test.tsx` |
| ST-05 | Memory (Context Tree) | Open Memory with and without GitHub authorization | Page stays reachable; connecting a tree follows its authorization | Core | smoke: `github-account-review.smoke.spec.ts`; unit: `features/agents/agent-settings/context-tree-settings.test.tsx` |
| ST-06 | Soul (instructions) | Edit and save Soul; browse templates; switch Agents | Saves, returns to reading, and keeps the section when switching Agents | Core | smoke: `navigation-polish.spec.ts`; unit: `features/agents/agent-settings/soul-editor.test.tsx` |
| ST-07 | Connectors (MCP) add and authorize | Add from Discover or custom; OAuth or API key | Connector is added once per Agent, authorization stays in its card, tools appear | Core | smoke: `mcp-add.spec.ts`, `mcp-connect.smoke.spec.ts`, `mcp-discover-authorization.spec.ts` |
| ST-08 | Connector recovery | Cancel OAuth, block its window, fail a tool probe, reauthorize | Only this attempt is undone or retried; a working credential survives an interrupted reauthorization | Edge | smoke: `mcp-recovery-smoke.spec.ts`, `mcp-discover-continuation-smoke.spec.ts`, `mcp-auth-rejection.spec.ts` |
| ST-09 | Connector list with any Agent name | Connectors page and MCP Server detail when an Agent has an uppercase or Chinese name | Both load without errors (the server detail does not list Agents) | Edge | manual |
| ST-10 | Skills | Add a Skill from a preset or source; open its files | Skill installs; file selection and links stay accessible | Core | smoke: `site-design-smoke.spec.ts`; sweep |
| ST-11 | Usage | Open Agent and Account usage | Charts and totals render for empty, partial, and full data bucketed by the viewer's timezone | Core | smoke: `usage-visual.spec.ts`; unit: `__tests__/agent-usage.test.tsx`, `features/agent-usage.test.tsx`, `features/account/cloud-usage-page.test.tsx` |
| ST-12 | Pause and resume | Pause an idle and a working Agent, then Resume | Idle pauses at once; working asks to confirm; state and message update | Core | unit: `features/agents/agent-settings/agent-manage-settings.test.tsx` |
| ST-13 | Delete a running Agent | Delete a running Agent and type its name | One confirmation pauses then deletes; lands on the Agent list | Core | unit: `features/agents/agent-settings/agent-manage-settings.test.tsx`, `__tests__/agent-home.test.tsx` |
| ST-14 | Delete failures | Pause fails; delete fails after the pause; no permission | Says nothing was deleted; says the Agent is paused and retries only the delete; names the missing permission | Edge | unit: `features/agents/agent-settings/agent-manage-settings.test.tsx` |
| ST-15 | Messaging permissions use one label | Agent whose messaging binding needs new permissions; open the list, Agent page, settings index, and messaging page | Every place reads "Messaging permissions need updating" / "需要更新消息权限"; the action is Update permissions | Core | unit: `features/agent-list-order.test.ts`, `__tests__/agent-messaging.test.tsx` |
| ST-16 | Model list can't be read | Model page while the computer is offline or its model list fails to load | One line by the model field ("Couldn't load the model list. You can type a model name."); no other notes; the model can still be typed | Edge | unit: `features/agents/agent-settings/runtime-configuration.test.tsx` |
| ST-17 | Self-configuration switch | Open Model settings for a Local Agent; toggle Self-configuration | The switch sits beside Ask for approval, saves on its own, and confirms the save; Name settings hold only the name | Core | unit: `features/agents/agent-settings/runtime-configuration.test.tsx`, `features/agents/agent-settings/general-config-form.test.tsx` |
| ST-18 | No copy that restates the page | Open Tasks, messaging, Computer, and Usage; edit Soul | No subtitle restates the title; while editing Soul, only the formatting hint is announced | Edge | unit: `__tests__/agent-messaging.test.tsx`, `__tests__/agent-usage.test.tsx`; manual |
| ST-19 | Unreported usage | Usage for an Agent where some Tasks reported no usage | A muted line under the totals ("1 个任务未上报用量"), not a warning banner | Edge | unit: `__tests__/agent-usage.test.tsx`, `features/agent-usage.test.tsx` |
| ST-20 | Connector failure names the next step | Connector with an unreachable or blocked address, a service without account sign-in, a rejected key, an unfinished authorization, an unreachable service | One short line per cause with its next step; the row offers Edit address, Update key, or Retry to match; upstream details stay private | Core | unit: `features/mcp/mcp-feedback.test.ts`, `features/mcp/mcp-list-recovery.test.tsx`; smoke: `mcp-recovery-smoke.spec.ts` |
| ST-21 | Shipped Skills read for people | Skills list, reader, and catalog for a Skill openTag ships | A short localized summary, not the SKILL.md description written for the Agent | Edge | unit: `features/skills/skill-summary.test.ts` |
| ST-22 | Paused messaging stays readable | Pause an owned Agent; open messaging with a saved Lark or Slack binding, a stopped binding, then no binding | Stored state, details, and connection failure reasons stay readable; an unbound Agent stays unbound; messaging writes stay disabled with their action labels and no false busy state; reads issue no messaging mutation | Core | smoke: `paused-settings-smoke.spec.ts` (Chinese, all four widths; stopped binding at 390px); unit: `__tests__/agent-messaging.test.tsx`, `im/slack-custom-app.test.tsx` |

## Computers and the connect command

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| CM-01 | Computer list | Open Computers with online, offline, disconnected, and Cloud Computers | Each card shows its state; offline and disconnected Local cards show “Last online …” or “No last-online record”; offline offers recovery; delete asks for confirmation | Core | unit: `__tests__/computer-management.test.tsx`, `__tests__/computers-delete.test.tsx`, `features/agents/computer-status.test.tsx` |
| CM-02 | Connect a new computer from the web | Computers or Agent settings: connect a new computer and copy the command | The copied text matches what the window shows; the page waits for that computer and shows it once connected | Core | smoke: `computer-connection.spec.ts`; unit: `features/computer-connect/computer-connect.test.tsx` |
| CM-03 | Repair a disconnected computer | Sole computer disconnected | Recovery repairs it in place without creating another | Core | smoke: `computer-connection.spec.ts`; connect C03r, C04r |
| C00 | Command exactly as the web shows it | Run the command the web emits on a fresh machine | Finishes without hanging; any failure is plain | Edge | connect C00 |
| C01 | Fresh machine | Run the connect command on a machine that never had openTag | One new Computer, online | Core | connect C01 |
| C02 | Rerun on a healthy machine | Connected machine; new code; run again | Same Computer, no duplicate, the running service is kept, online | Core | connect C02 |
| C03 | Service stopped | Stop the local service; run a new connect command | Same Computer, no duplicate, back online | Core | connect C03, C03r |
| C04 | Disconnected on the Server side | Setup (no Web action exists for this): disconnect the Computer through the authorized `POST /api/v1/computers/:id/disconnect` API. Then run a new command (create or recovery code) | Same Computer, no duplicate, back online | Core | connect C04, C04r |
| C05 | Local identity lost | Delete the local identity file; rerun | Connects as one new Computer; the old one is not repaired and shows offline once its service stops | Edge | connect C05 |
| C06 | Old version installed | Previous release installed and connected; rerun | Upgrades, same Computer, online | Core | connect C06 |
| C07 | Expired code | Run a command whose code is past its 15-minute lifetime | Plain failure with the next step; no Computer created | Core | connect C07 |
| C08 | Already-used code | Run a command whose code another machine redeemed | Plain failure; no Computer created | Edge | connect C08 |
| C09 | Retained identity bound to another Account | Keep the local identity connected as another Account; this user runs their command | Plain account-conflict failure; nothing created; the other Account untouched; the code is not used up | Edge | connect C09 |
| C10 | Server unreachable | Releases download but the Server refuses connections | Plain failure; no Computer created; the code is not used up | Edge | connect C10 |
| C11 | Home directory not writable | Run on a machine whose home is read-only | Plain failure; no Computer created; the code is not used up | Edge | connect C11 |
| C12 | No curl, no system Node.js | Run without curl; run without node | Without curl: plain failure, code not used up. Without node: the bundled runtime connects | Edge | connect C12a, C12b |
| C13 | Previous CLI release | The previous release reruns its own connect against this Server | Connects, same Computer, online | Edge | connect C13 |
| C14 | Computer removed in the web | On Computers, More → Remove and confirm; rerun on the same machine | One new Computer, online | Edge | connect C14 |
| C15 | Same command twice | Run the identical, now-used command again | No duplicate, same Computer, online, plain message | Edge | connect C15 |
| C16 | Machine handed over | Another Account deletes the machine's Computer; this user connects | One new Computer for this user; the other Account's deleted Computer untouched | Edge | connect C16 |
| C17 | Home lost while offline | Local openTag home removed while the computer is off; rerun | Connects; one new Computer; the original untouched | Edge | connect C17 |
| C18 | Clone of an online machine | A cloned machine connects while the original is online | One new Computer; the original untouched | Edge | connect C18 |
| C19 | Same image, other machine | Another machine from the same image while the original is offline | One new Computer; the original untouched | Edge | connect C19 |
| C20 | Second OS user | A second OS user on the same machine connects | Connects as its own Computer, online | Edge | connect C20 |
| C21 | Command from Agent setup | Run the command issued by Agent setup | Connects and runs the Agent's local readiness checks; prints only the outcome and one next step | Core | connect C21 |
| C22 | Lost identity connects to another Account | Remove the local openTag home from a Computer owned by another Account; connect with this Account's code | One new Computer for this Account; the other Account's Computer is untouched; no conflict or cross-Account disclosure | Edge | unit: `__tests__/computer-connect-idempotent.test.ts` |

## Tasks

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| TK-01 | Task list | Open an Agent's Tasks (in production builds the all-Agents `/tasks` route redirects to the Agent list) | Rows show title, source, status, last activity; loading, empty, and failure states are distinct | Core | unit: `features/tasks-page.test.tsx`, `__tests__/agent-tasks.test.tsx`; sweep |
| TK-02 | Next page fails | Load more Tasks when the next page fails | Loaded Tasks stay; the failure offers a retry | Edge | unit: `__tests__/agent-tasks.test.tsx` |
| TK-03 | Task detail | Open a Task | Back link and title span the content frame; the facts, cancel control, and internal Sessions read before the conversation | Core | unit: `features/task-conversation.test.tsx`; sweep |
| TK-04 | Each reply once | Task with Agent replies | Each reply appears once in the timeline, without per-message status labels | Core | unit: `features/task-conversation.test.tsx`, `features/task-outgoing-replies.test.tsx` |
| TK-05 | Cancel a Task | Cancel a queued Task (only queued Tasks offer Cancel) | Asks to confirm; the status reads "已取消" / "Cancelled" (not Completed) and the Task still appears under the Completed filter | Edge | unit: `features/task-cancel.test.tsx`, `features/tasks-page.test.tsx` |
| TK-06 | Narrow Agent workspace | Agent home, Tasks, and Skills in a narrow Agent workspace | Stay usable without overflow | Edge | smoke: `app.spec.ts` |
| TK-07 | Long internal Session title | Task with an internal Session whose title fills 120 characters, at 390, 1024, 1440, and 2000px; reopen it from the list | The title stops at two lines at 390, 1440, and 2000px and one line at 1024px; Status and the row's status stay in view; the content never scrolls sideways | Edge | smoke: `task-detail-layout-smoke.spec.ts` |
| TK-08 | Internal Session rows | Task with internal Sessions; hover a title, then reach it by keyboard | Heading is no larger than the Task title; rows sit between rules with no card; the id appears only in the tooltip, which hover and keyboard focus both open; a row named by its id is plain text with no focus stop | Core | smoke: `task-detail-layout-smoke.spec.ts`; unit: `features/tasks-page.test.tsx` |
| TK-09 | Request message fill | Task with a one-line request and a long request | Each grey fill follows its message and has no border or shadow; the long one spreads across the frame; the sender's avatar is round like the Agent's | Edge | smoke: `task-detail-layout-smoke.spec.ts` |
| TK-10 | Two-column Task detail | Long Task at 1280 and 1440px with many internal Sessions; scroll the conversation, then the side column; reach everything by Tab; repeat at 1024 and 390px | Side column stays in view and the jump control stays in the conversation column; a too-tall side column scrolls alone and takes a Tab stop; Tab reads the title, side column, then conversation; 1024 and 390px show one column | Core | smoke: `task-detail-layout-smoke.spec.ts` |

## Account

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| AC-01 | Sign in and sign out | Sign in with a wrong, then the right password; sign out | Wrong input is kept with an error; the right one opens the product; sign out returns to sign-in | Core | smoke: `login-smoke.spec.ts`, `app.spec.ts`; unit: `__tests__/sign-out-escape-hatches.test.tsx` |
| AC-02 | Protected routes | Open a protected page signed out | Redirects to sign-in and returns to the page after sign-in | Core | smoke: `browser-smoke.spec.ts`, `app.spec.ts` |
| AC-03 | Registration | Register through the form | Account is created and setup opens | Core | smoke: `login-smoke.spec.ts` |
| AC-04 | Account settings | Open Account | Readable beside the navigation; when a GitHub authorization exists, it can be retired | Core | smoke: `responsive-smoke.spec.ts`, `github-account-review.smoke.spec.ts`; unit: `__tests__/account.test.tsx` |
| AC-05 | Account menu | Open the Account menu with the keyboard and by touch | Every destination is named and reachable; it closes on an outside click | Edge | smoke: `navigation-polish.spec.ts`, `browser-smoke.spec.ts` |
| AC-06 | Cloud credits | Account with a Cloud credit banner | Banner actions keep touch-size targets on phones | Edge | smoke: `cloud-billing-smoke.spec.ts` |
| AC-07 | Account profile reads plainly | Open Account | No page subtitle; the sign-in email is plain text, not a locked input; display name and language have no helper sentences | Edge | unit: `__tests__/account.test.tsx` |
| AC-08 | Sign-in errors in the reader's language | On the zh page: wrong password; register an email that exists | "邮箱或密码不正确。" and "此邮箱已有账户，请直接登录。"; no English Server message in either language | Core | unit: `features/auth/login-page.test.tsx`, `__tests__/auth.test.tsx` |

## Languages and widths

| ID | Scenario | Steps | Expected result | Run | Verified today |
| --- | --- | --- | --- | --- | --- |
| LW-01 | Language negotiation | Open the product with a Chinese, then an English, browser | Matching language renders without saving an implicit preference; switching language works | Core | smoke: `i18n.spec.ts`, `login-smoke.spec.ts` |
| LW-02 | Copy in both languages | Every page in zh and en | No untranslated or mixed copy; product names (openTag, Lark/飞书, Slack) follow the brand rules | Core | unit: `__tests__/i18n-catalog.test.ts`; sweep |
| LW-03 | 320px | Primary pages at 320px | No page overflow; primary actions stay visible and keyboard-ordered | Core | smoke: `responsive-smoke.spec.ts`; sweep |
| LW-04 | 390px | Primary pages at 390px | Primary action and touch targets (at least 44px) stay inside the viewport | Core | smoke: `responsive-smoke.spec.ts`; sweep |
| LW-05 | 768px | Primary pages at 768px | Layout transitions cleanly beside the navigation | Core | smoke: `responsive-smoke.spec.ts`; sweep |
| LW-06 | 1440px | Primary pages at 1440px | Content frame is centred and bounded | Core | smoke: `responsive-smoke.spec.ts`; sweep |
| LW-07 | Keyboard and accessibility | Tab through each page; run accessibility checks | Every action reachable; dialogs trap and restore focus; no serious accessibility violations | Core | smoke: `browser-smoke.spec.ts`; sweep |
| LW-08 | Focus survives in-place changes | With the keyboard: toggle a Skill switch; Pause, then Resume a schedule; continue from the Agent type step | Focus stays on the switch or button while its write is pending, which reports busy and ignores a second press; the next setup step focuses its heading | Edge | unit: `features/skills/skills-page.test.tsx`, `features/agents/agent-schedules-section.test.tsx`, `onboarding-v2/agent-create-cloud.test.tsx` |
| LW-09 | Agent list tab order and plain healthy rows | Tab through an Agent list row that has an action; read a healthy status row | The row's open link comes before its action; a healthy row with nothing to act on is text, not a button | Edge | unit: `__tests__/agent-computers.test.tsx`, `__tests__/app-shell.test.tsx` |
