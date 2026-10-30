# Agent Memory redesign acceptance record

## Cloud creation integration (local, not yet published)

The working tree integrates main `4cf2978b64f74a3b3fcaddf37ef3e57558a207d5` into
`e9a9e478bd2aec32e142b6aef788f2af4cc6377b`, adopting Cloud creation from both the empty
state and the secondary collection menu. The previous Cloud-only connect description is retired.
The Cloud rows in the earlier `single-tree-matrix.json` are historical; current Cloud acceptance is
`cloud-integration.json`. Other earlier single-tree flows remain unchanged.

Captured 2026-10-26 with the production App/router and synthetic APIs; no real repository was created.
`cloud-integration.json` records the exact component SHA-256, base and integrated main revision.
It contains 16 successful create flows (two entries × en/zh × 320/390/768/1440) and eight uncertain
creation/recovery flows. Each create sends one request with expected Agent/runtime revisions;
recovery retains the attempted repository, locks repeated creation, focuses the prefilled connect
input and sends no automatic retry. All measured pages/dialogs fit their viewport.

- [Cloud create from collection, English 1440 × 1000](memory-cloud-create-en-1440-connected.png).
- [Cloud create from empty state, Chinese 320 × 1000](memory-cloud-create-zh-320-empty.png).
- [Cloud empty state, Chinese 390 × 1000](memory-cloud-empty-zh-390.png).
- [Uncertain Cloud creation, Chinese 390 × 1000](memory-cloud-uncertain-zh-390.png).
- Additional create captures cover the opposite entry at both representative widths.

Local validation: the first focused command passed 52 and failed one catalog assertion because
Biome split a message reference across lines; a separate description variable fixes that formatting
interaction without weakening the catalog guard. The corrected catalog passed four tests. The old
page-test path matched no file, so the actual `src/__tests__/context-tree-page.test.tsx` was then run:
four tests passed. Web typecheck, the production App fixture build and `pnpm check` passed.
No fresh Cloud axe scan or deployed acceptance is claimed. GitHub access failed in this scheduled
entry, so publication, new-head CI, reviewer clearance and remote ledger persistence remain pending.

## Current layout

Memory uses the shared resource PageHeader without a primary action. A typical Agent's single
Context Tree appears as a divided collection row; connecting another tree is a secondary action at
the end of that collection and disappears at the 32-tree limit. The empty state keeps direct
Connect Context Tree and Create Context Tree shortcuts. English consistently uses Context Tree and
Chinese consistently uses 知识树.

Disconnect identifies the exact Context Tree, blocks duplicate submissions, and restores focus to
a surviving collection action. Creation outcomes that are unknown are retained by case-insensitive
repository identity, including when a background config refresh changes the revision before the
response arrives. A confirmed connection clears only the matching unresolved repository.

## Current screenshots

These screenshots were captured on 2026-10-26 from the production App/router/shell fixture and a
production Web build whose rendered UI is based on `1c44c89588ae4628eabc6b0a6878337c3e46d489`.
The capture working tree also contained only the later nonvisual uncertainty-race correction. Account,
Computer, Agent config, and repository data are synthetic; the fixture makes no real repository,
connection, or runtime mutation.

- [English connected, 1440 × 1000](memory-final-en-1440-connected.png) — one Context Tree and the
  in-collection **Connect another Context Tree** action.
- [English empty, 1440 × 1000](memory-final-en-1440-empty.png) — the single-tree-first empty state.
- [Chinese connected, 390 × 1000](memory-final-zh-390-connected.png) — the responsive collection and
  secondary **连接另一棵知识树** action.
- [Chinese empty, 390 × 1000](memory-final-zh-390-empty.png) — responsive empty-state shortcuts.
- [Chinese connect dialog, 320 × 1000](memory-final-connect-zh-320.png) — the narrow repository and
  directory form opened from the collection action.

The pre-revision screenshots, matrix, flow report, and recovery-disclosure report were removed from
the active evidence directory; PR history preserves them without presenting the old header action and
source counter as current behavior.

## Verification

- `pnpm --filter @opentag/web test src/features/agents/agent-settings/context-tree-settings.test.tsx`
  — 31 tests passed, including multiple unresolved identities, matching recovery, config-revision
  uncertainty, operation limits, and focus restoration.
- `pnpm --filter @opentag/web build` passed before capture. Existing browser-externalization and
  chunk-size warnings remain.
- Each capture was inspected at its original viewport. The connected and empty states contain the
  expected localized labels, and the 320px dialog keeps all fields, guidance, and actions in view.
- The four English 320px connected states were rechecked on 2026-10-28 after allowing the trailing
  collection action to shrink and wrap. Connected, active, offline and offline-active each measured
  `320/320` for both document and main client/scroll widths; the collection measured `286/286`.
  The **Connect another Context Tree** accessible name, two-item menu and Escape focus return remain
  unchanged. No tracked English 320px screenshot existed to refresh.

This is focused local visual evidence, not a replacement for full CI, authenticated deployed
acceptance, real GitHub authorization/publication, or exhaustive accessibility testing.

The prior review is [product Issue 1019](https://github.com/first-tree-ai/opentag/issues/1019).


## Additional current-layout acceptance

The original published `94dda10e` source, limit/focus fixes and new `memory-final-*` core captures
are preserved. Independent en/zh four-width acceptance against the same rendered layout adds:

- `single-tree-matrix.json`: 56 states and 8 connect-dialog widths, no page/main overflow. States cover
  empty, connected, active, offline, combined restrictions, Cloud and 32 long-name trees. The four
  English 320px connected rows reflect the final narrow-action rerun described above.
- `single-tree-flows.json`: 8 A→B→A lock/recovery flows, exact prefill/input focus, no automatic write,
  keyboard trailing action, expanded-help fit, first-connect and last-disconnect focus.
- `single-tree-axe.json`: 4 scoped WCAG A/AA/2.1 AA scans without automatic violations; not a complete
  accessibility acceptance.
- New `memory-final-disconnect-en-390.png`, `memory-final-uncertain-en-390.png` and
  `memory-final-uncertain-help-zh-320.png` show current confirmation and recovery states. Their source
  was the same `1c44c895` UI with the nonvisual late-uncertainty fix, matching the core captures above.

Raw `/favicon.ico` observations are retained separately from business API assertions. No unintended
business API or real external write occurred. The first current-matrix attempt found the local preview
stopped (connection refused); restoring it and capturing the complete runs resolved the harness issue.
Native gates/new-head CI and review remain separate; no merge/deploy or live runtime acceptance.
