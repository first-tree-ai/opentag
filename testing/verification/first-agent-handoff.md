# Completion handoff revision verification

Supports the [Web UI contract](../../docs/system/web/web-ui-contract.md).

## Scope

The Web only hands off to a real Bot conversation: ready state, actual identity,
one prominent conversation action, a short collapsible search/name-copy fallback
and secondary View agent. It contains no starter examples, editable request form,
follow-up coaching or Hello/delivery-test tutorial. No message is sent by the Web.

IM first-DM/help options are separate research in
[first-agent-handoff-im-research.md](first-agent-handoff-im-research.md).
No IM menu, event, permission, welcome send or new persistence semantics is implemented.

## Revision baseline and early presentation

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

## Coordinator acceptance for the revised candidate

1. Serve the exact committed candidate through the approved coordinator flow.
   Record source/build and served Web artifact identity. Use the admitted owning
   Account and exact existing Agent setup route; do not reset data or use creation
   or reboard flags to simulate a new user.
2. Capture the revised completion against the real `3346789e` baseline. Confirm
   ready state, actual Bot name, one prominent Bot action and secondary View agent.
   No request input, example selector, task coaching or Hello instruction remains.
3. Begin native entry from a known non-chat state. Click the actual Web button and
   record each browser landing click and external-App confirmation. Require the
   correct App/workspace/Bot private conversation with usable input; a profile,
   search dialog, group or App window alone does not pass. Record inconclusive
   observations without inventing a failure or success.
4. Expand the short fallback, verify the actual Bot name and name copying, then
   return to the Web. View agent must open the exact Agent overview. The page does
   not auto-navigate or send anything.
5. Present redacted real before/after captures and actual results before delivery
   claims. Match viewport and disclose DPR differences. Verify responsive/keyboard
   behavior separately before claiming it; do not generalize one provider's run to
   other brands or infer a first-time welcome from an existing DM.

The coordinator alone operates the desktop/shared acceptance service. This task
performs no browser automation, service switch, provider setup or test messages.

## Local validation

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
