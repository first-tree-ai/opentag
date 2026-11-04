# Agent overview Bot identity verification

Supports the [Web UI contract](../../docs/system/web/web-ui-contract.md).

## Problem and patch

The overview presented an internal Agent handle as the Feishu Bot address, even when the
stored provider Bot name differed. The Messaging settings page already showed the provider
name. The overview now uses that same stored name for Feishu and Slack, or the provider alone
when the name is unknown. Its header no longer presents the internal handle as an IM address.
The Agent name, display name, persisted identity, and messaging configuration are unchanged.

Production changes are limited to three files:

- `agent-presentation.ts`: add `messagingBotLabel`, a presentation function over the existing
  binding summary. Keep `messagingChannelLabel` unchanged for the settings index.
- `agent-status-card.tsx`: use the Bot label in the Messaging row, its accessible identity,
  and its existing title. This component's only production caller is the overview.
- `agent-detail-page.tsx`: explicitly hide the handle on the overview. Keep the shared header's
  default behavior for `LegacyAgentCapabilityPage`, its only other production caller. Preserve
  creator attribution, the Agent heading, and Settings navigation.

No chat entry, invitation, permissions, provider request, status policy, or data contract is added.
No schema, migration, runtime, or message-delivery code changes.

## Evidence and deduplication

Base: `d50c96e9de8930146b5e5aff1c9f5c5c22c01e1a`.

The old live path was overview -> `AgentStatusCard` -> `messagingChannelLabel`, which always
returned the internal handle for Feishu. The shared Agent schema separates internal and display
names, and Feishu setup registers the display name. Bot names are independently stored on the
binding. An offline evaluation of the original function confirmed that Feishu ignored a different
stored Bot name while Slack used it. That was source evidence, not native search evidence.

Inspected PR patches before implementing:

| PR | Head | Relevant boundary |
| --- | --- | --- |
| #1261 | `3346789e55849a3a1970dd99e92b48e4df6b833f` | Completion handoff, actual Bot name, search/access fallback and starter requests. No completion changes here. |
| #1250 | `128d72b3a70eac3eb886896afb4b9d921512e9d0` | Home empty state, settings actions and navigation. Keep its `AgentTasksSection` and navigation changes separate. |
| #1254 | `eb5f3a7b3ed8cef5d2cc2fcdb7fadd1fb1f5fdbd` | Switcher keyboard scrolling. No overlap with identity rendering. |
| #1249 | `5a10aa3b0eb2cdffe37aa387d0d7feca7cde1581` | Settings form focus, surfaces and copy. No settings changes here. |
| #1239 | `17df41271bb1fbf70c9c988aee4a5f2c011207c4` | Paused messaging reads and controls. No paused-state changes here. |
| #1034 | `d7f2ccbe54086af0ccebf1218a6b689cba5d8c14` | Slack setup/chat entry. Preserve existing Slack identity behavior. |
| #1243 | `db9e74d914a50c6e39123fe3ea59552391bd3954` | Status/configuration identity; its presentation hunks do not touch the new Bot-label function. |

The Web remains an admin console. A teammate should work in IM; an owner-only Web URL is not
an invitation, and finding a Bot does not restore another person's private chat or a group topic.
No additional sharing feature is justified by this identity patch. Teammate discovery remains
unverified and the existing completion guidance belongs to #1261.

## Real baseline and remaining acceptance

The coordinator supplied an actual existing-Agent overview captured before any B2 product edit,
after real **View agent** navigation. Metadata: source
`968890cc7b763f06a0f4e111612f2c6ff1a341d8`, English, actual screenshot size **1920 x 902**.
The local artifacts are named `overview-baseline.json` and
`before-overview-redacted-1920x902.jpg`; the Computer hostname is masked. They remain outside Git.

Source comparison from that captured revision to the implementation base has no changes in
`agent-detail-page.tsx`, `agent-presentation.ts`, or `agent-status-card.tsx`.
The dedicated test Agent's Bot name and internal handle happen to match. This baseline therefore
establishes the real overview surface, not a demonstrated different-name native-search failure.
Different-name and unknown-name behavior is proved only by component tests.

This patch remains a draft pending coordinator-only real after acceptance in a new explicit
bounded desktop window. No child desktop or browser operation, shared-instance switch, provider
message, or database operation was performed.

Coordinator after script (ten minutes; no resets, renames, or visibility changes):

1. Verify the served source/build and open the existing dedicated Agent overview using the same
   English viewport as the baseline. Capture its header and Messaging row, masking the hostname.
2. Verify the Agent heading and Settings navigation are unchanged; no internal `@handle` is
   advertised as an IM address. The Messaging row shows the stored Bot name without a synthetic
   `@`, or only the provider if no Bot name is available.
3. Compare the displayed Bot name with the existing Messaging/native Bot identity. If the
   dedicated Agent cannot exercise different or unknown names, record those native cases as
   uncovered; do not rename or disconnect it to manufacture evidence.
4. Check the overview at 390px and keyboard navigation, then return to the existing overview.
   Record actual overflow/focus results. No new control is introduced by the patch.
5. Record before/after results and release the desktop/reservation. Native search, cold-start
   onboarding, group-topic continuation and colleague access are separate unverified cases.

## Local validation

- `pnpm install --frozen-lockfile`: completed with normal prepare hook installation; no manifest
  or lockfile changes. The package manager reported its existing ignored dependency build scripts.
- Shared and MCP preset builds passed to prepare public workspace exports for Web tests.
- Focused Web validation covers overview identity and existing home, messaging, presentation,
  settings layout, list-order, and legacy capability behavior. The initial run found the old
  expected Feishu label plus overly strict new assertions. After correcting those assertions,
  the two affected test files passed; the other five unchanged files had already passed.
  Final scope: **91 tests across seven files**.
- New component cases cover different Bot names and unknown names for both providers, an unbound
  overview, exact Settings navigation, unchanged Agent heading, and the legacy capability header.
- Web typechecking and repository checks are recorded in the PR alongside their final results.
- No application production build was required: the change alters display logic only, with no
  exports, generated inputs, dependencies or packaging changes. Generated Paraglide messages were
  prepared normally and not edited or committed.
- PostgreSQL integration and Agent Runtime coverage were not run because their behavior and
  contracts are untouched. Native visual/responsive/keyboard acceptance remains pending.
- CI owns the complete regression matrix; local checks do not establish CI success.
