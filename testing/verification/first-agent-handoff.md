# Completion step and handoff verification

Supports the [Web UI contract](../../docs/system/web/web-ui-contract.md).

## Scope

The whole completion step uses an open, compact layout: a subdued completed rail,
the ready heading, a single Bot identity row, conversation and management actions
together, and a short help disclosure. There is no configuration-card boundary or
detached footer. Other onboarding stages and global navigation are unchanged.

The Web only hands off to a real Bot conversation: ready state, actual identity,
one prominent conversation action, a short collapsible search/name-copy fallback
and secondary View agent. It contains no starter examples, editable request form,
follow-up coaching or Hello/delivery-test tutorial. No message is sent by the Web.

IM first-DM/help options are separate research in
[first-agent-handoff-im-research.md](first-agent-handoff-im-research.md).
No IM menu, event, permission, welcome send or new persistence semantics is implemented.

## Whole-step redesign baseline and acceptance boundary

Before this implementation, the coordinator showed the historical real `11320c19`
page and an explicitly unimplemented whole-step concept. It then captured the
actual merged baseline `3800923794afe704613df92ee386353e9f9f0baf`, build `193b2c42`,
using the same existing Account, Agent and completion route at 1920 × 958 CSS
pixels, DPR 1, with collapsed and expanded fallback, and at 390 × 844, DPR 1.
The served Web index matched the built artifact. The environment remained on
schema 0073; the later upstream migration is not part of this candidate.
No IM messages or settings/data changes were made during capture.

The new candidate requires coordinator-captured after views against this
`38009237` baseline. The concept is a layout reference, not an implemented screen
or acceptance evidence. Historical screenshots and provider checks below do not
prove acceptance of the new composition. Desktop, expanded fallback, narrow and
long-name views need overflow and focus checks. Loading/missing identity and
explicit re-board pending/retry behavior are covered locally and need accurate
labels in the real page. Actual after-capture is pending at this commit.

## Historical reduction baseline and early presentation

The coordinator captured the real prior implementation at
`3346789e55849a3a1970dd99e92b48e4df6b833f`, build
`ea24fc5e-2280-42a7-8455-b6533b3bcc96`, at 1920 × 958 CSS pixels, DPR 1, English.
The served Web index matched that build (SHA-256
`35da7347f019f8600fde7bdc7f6a69deea649c701f2242dc472ba43fc64de07b`).
It included the now-rejected request form. Its earlier functional checks do not
accept that product direction or validate this revision. The coordinator presented
that actual page and the smaller handoff concept before this revision began.

The older source `968890cc` baseline used DPR 2; it is historical context, not a
pixel-identical revision comparison. These are existing-Account/Agent runs and
coordinator operations, not cold-start or novice-usability evidence. Private
originals, App IDs, account identifiers and host details remain outside Git.

## Provider entry boundary

[Slack's official redirect](https://docs.slack.dev/interactivity/deep-linking/) backs
the existing App/Team helper. The [official Feishu Bot AppLink](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/applink-protocol/supported-protocol/open-a-bot)
opens the identified Bot conversation when it is available to the user. Retain the
supported HTTPS handoff; do not invent a native URI or infer its brand from locale.
Unknown/unconfirmed entries retain real-name search instead of a fabricated link.

A browser landing, opening the App, or an already-open DM does not prove that the
button reached the correct private conversation. Prior observations included a
browser confirmation and correct DM, and a later inconclusive search dialog.
The revised candidate needs the stricter non-chat-start check below. System
confirmation and extra landing-page clicks must be recorded separately.

The coordinator's later `11320c19` check began on the dedicated Bot's Files tab,
with no composer. The actual Web entry returned to the correct Bot but retained
Files and no composer. A subsequent bounded exact-current-actor P2P `chat/open`
comparison retained the same state. Neither result supports adding a user-chat
mapping or guessed tab parameters. The condition remains a known limitation;
it does not establish that all first-use entry fails. This redesign retains the
official HTTPS URI and adds no provider messages, scopes or mapping API.

## Coordinator acceptance for the revised candidate

1. Serve the exact committed candidate through the approved coordinator flow.
   Record source/build and served Web artifact identity. Use the admitted owning
   Account and exact existing Agent setup route; do not reset data or use creation
   or reboard flags to simulate a new user.
2. Capture the revised completion against the real `38009237` baseline. Confirm
   ready state, actual Bot name, one prominent Bot action and secondary View agent.
   No request input, example selector, task coaching or Hello instruction remains.
3. Confirm that the rendered provider URL and binding identity remain unchanged.
   Retain the known native Files-tab limitation above; a layout change does not
   fix it. If the protocol or destination changes, repeat the non-chat-start
   native check and record every landing click and external-App confirmation.
   Require the correct App/workspace/Bot private conversation with usable input;
   a profile, search dialog, group or App window alone does not pass.
4. Expand the short fallback, verify the actual Bot name and name copying, then
   return to the Web. View agent must open the exact Agent overview. The page does
   not auto-navigate or send anything.
5. Present redacted real before/after captures and actual results before delivery
   claims. Match viewport and disclose DPR differences. Verify responsive/keyboard
   behavior separately before claiming it; do not generalize one provider's run to
   other brands or infer a first-time welcome from an existing DM.

The coordinator alone operates the desktop/shared acceptance service. This task
performs no browser automation, service switch, provider setup or test messages.

## Local validation — whole-step redesign

The initial full affected setup/preview, route-boundary and i18n selection passed
401 tests across 27 files. Source review then identified that a missing Bot name
must not hide a verified App entry or its Connected state. After correcting that
condition, 174 focused tests passed across six files: completion handoff, setup
page, lab page, completion synchronization and both branding/terminology guards.
This final run covers null/empty/whitespace names with a valid entry, a nameless
unknown-brand binding without a guessed URL, loading/unavailable identity with
management still usable, long names and exact name copying, colocated actions,
late-result/generation fences, and explicit re-board ready/pending/retry behavior.
The two runs are separate evidence; the 401-case run predates that correction.

Final Web typecheck, Web build, bundle report and `pnpm check` passed. The build
retains its existing 500 kB chunk warning; the bundle report totals 3,726,121 bytes.
The complexity gate was satisfied by separating identity rendering from entry
composition; no threshold or baseline was changed. Normal commit/push gates
remain required. This Web-only change does not rerun server/database or Agent
Runtime suites locally. Actual new visual/keyboard/native acceptance and CI are
separate from these local checks and are not claimed by the passing unit tests.

## Historical local validation — 11320c19

Fresh completion/setup/preview, route-boundary and i18n regressions passed all
393 tests across 27 files. These cover the reduced surface, absence of request
inputs/coaching, real-name copying and its failure guidance, identity/late-result
fences and existing setup/reboard behavior. Web typechecking, the affected Web
build and bundle report passed; the build retains its existing chunk-size warning.

Run `pnpm check` before committing and retain normal Git hooks. Server/database
and Agent Runtime suites are outside this Web-only local scope unless implementation
crosses those boundaries. Previous-head CI and functional checks are historical
evidence only. New-head CI, formal review and actual native/visual acceptance remain
separate requirements.
