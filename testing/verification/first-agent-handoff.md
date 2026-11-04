# First Agent completion handoff

Supports the [Web UI contract](../../docs/system/web/web-ui-contract.md).

## Real baseline

The coordinator captured the existing, ready test Agent's actual completion screen
before implementation. This was an admitted Account, not a cold-start Account or
an unfamiliar-user observation. The screen showed Connected, readiness/Hello
instructions and View agent; it offered no direct Bot entry or useful example.

| Evidence | Recorded value |
| --- | --- |
| Running source | `968890cc7b763f06a0f4e111612f2c6ff1a341d8` |
| Build identity | `76ed87ac-c5c6-499b-8132-f16f14425d33` |
| Served/local Web index SHA-256 | `fedaef5fb506f46d5fb7a3f82b24a1f3d59f2b630047480560402bd1f5d95f2f` |
| Viewport / locale | 1920 × 958, DPR 2, English |
| Development base | `d50c96e9de8930146b5e5aff1c9f5c5c22c01e1a` |

The completion component, setup page/adapter, onboarding stylesheet and catalogs
have no diff between the running source and development base. This makes their
completion UI comparable; it does not make the entire builds identical.
Private screenshots, App IDs, account identifiers and machine information remain
outside Git.

The coordinator reported that the fixed three-note request produced the correct
owners/dates and marked missing information pending. Its follow-up retained the
open questions; View agent returned to the exact overview. The official Feishu
AppLink landing identified the correct Bot, but native launch was not verified.
The desktop was released before implementation. No after screenshot exists yet.

## Scope and overlap

The change only adds the completion handoff and its optional existing-API identity
read. Unknown brands use the actual Bot name without inventing a URL. Direct links
also retain a search fallback. Examples are editable and copied only on request;
the person sends them in IM. No messaging, runtime, schema or analytics behavior changes.

Reviewed open PR heads: [1250](https://github.com/first-tree-ai/opentag/pull/1250)
`128d72b3`, [1034](https://github.com/first-tree-ai/opentag/pull/1034) `d7f2ccbe`,
and [1249](https://github.com/first-tree-ai/opentag/pull/1249) `5a10aa3b`.
Their Agent home, settings and Slack configuration interactions are outside scope.
Only the onboarding catalog/test and Web contract overlap need reconciliation.

[Slack's official route](https://docs.slack.dev/interactivity/deep-linking/) backs
the existing App/Team helper. An [official Feishu tutorial search excerpt](https://open.larkoffice.com/document/develop-an-echo-bot/introduction)
backs the Feishu Bot AppLink and application-name search within the app's availability
scope; direct extraction returned no readable body. Lark's Bot URL remains unconfirmed.
Documentation or a successful landing is not native-client acceptance.

## Acceptance still required

The coordinator repeats the same dedicated scenario and fixed input at the same
viewport on an approved candidate build. No data reset or new environment is needed.

1. Open the existing Agent's exact setup route with its admitted owning Account.
   Record the served Web artifact and Server/runtime versions. Do not use creation
   or review/reboard flags to simulate a first user.
2. Capture the changed completion. Verify one prominent Bot action and secondary
   View agent; copy/edit both examples and confirm no message is sent automatically.
3. Open the correct provider Bot. Record native launch separately from a browser
   landing. Expand the search fallback and verify the real Bot name/access guidance.
4. The person sends the original fixed three-note action-list request and follow-up.
   Verify provided facts, missing values and conversation continuity. Product examples
   use replaceable relative dates; the acceptance packet keeps its fixed input.
5. Return to the Web and open the exact Agent overview. Present redacted real
   before/after images, outcomes and PR together. Never commit sensitive raw images.

Cold-start creation, novice comprehension, other providers' native launch and visual
or responsive acceptance remain separate, unverified claims. This development task
performs no desktop/browser automation or shared-instance operations.

## Local validation

- Focused completion/setup/preview, route-boundary and i18n regressions: the broad
  run passed 25 of 27 files; two completion tests still required the replaced Hello
  instruction. After updating those assertions and adding an adapter-through-page
  regression, all three affected files passed (153 tests). Together with the
  unchanged passing files, the final behavior has 393 passing tests across 27 files.
- `pnpm --filter @opentag/web typecheck` passed.
- `pnpm build` passed all eight workspace builds and the bundle report, preparing
  package exports for normal pre-push typechecking as well as bundling the new
  completion imports and generated messages. Existing TypeScript API and web chunk
  size warnings remain.
- `pnpm check` and `git diff --check` passed. No lint or complexity gate was relaxed.

Normal pre-commit/pre-push hooks remain enabled. Server/database integration and
Agent Runtime coverage were not run because this is a Web-only change with no
schema, messaging or runtime behavior change. Local checks do not establish CI,
formal review or native/visual acceptance.
