# Memory experience review

## Outcome and scope

Review requested by Gandy on 2026-10-23: make the Agent Memory experience fluid, concise, elegant, and consistent with the other Agent pages. This review covers the current connection lifecycle, not a new memory editor, a permission model, or a change to runtime preparation.

Recommendation: preserve the existing openTag design system and simplify the page around sources, one clear next action, and recoverable operations. Fix operation safety, conflicting restrictions, focus, and recovery before decorative changes. Nothing in this review establishes that production has been fixed.

## Evidence and limits

- Baseline: `first-tree-ai/opentag` commit `7eecce24`. Memory product code is unchanged in this worktree. The Schedule redesign in the same task is separate work in progress.
- Real `ContextTreeSettings` component, real Kumo adapter, real application CSS and translations, built with Vite; synthetic configuration, API outcomes, delays, and successful configuration refresh. This isolates UI behavior; it does not verify GitHub authorization, repository creation, remote content, or runtime readiness.
- Browser: headed Chrome. 56 combinations: English and Chinese; 320, 390, 768, and 1440px; empty, connected/paused, connected/active, offline/paused, offline/active, Cloud empty, and 32 long source names. No page-level horizontal overflow in this isolated component fixture. This is not a full application-shell responsive acceptance run.
- Additional real-component flows: required input, folder URL rejection, invalid directory, uncertain creation, delayed disconnect, first successful connection, last disconnect, cancel focus return, and Cloud authentication failure.
- Two representative axe scans (invalid-directory and authentication-error dialogs, WCAG A/AA and 2.1 AA tags) found no automated violations. Manual inspection still found invalid-directory semantics and post-mutation focus defects; axe does not establish complete accessibility.
- Existing Memory component and route tests: 2 files, 19 tests passed. The fixture build passed, with the existing shared-package `node:crypto` browser-externalization warning. No product implementation was changed, so no application-wide regression or deployment acceptance is claimed.
- The current browser session at `https://dev.opentag.build` redirects to sign-in. Findings below are marked as browser observations or code-path findings; there was no authenticated deployed Memory journey in this review.
- Raw summaries: `memory-matrix.json`, `memory-flow-results.json`. Screenshots use `memory-review-*.png`; earlier baseline captures use `memory-before-*.png` in this directory. The temporary fixture is `apps/web/output/playwright/review.tsx`; the interaction driver is `apps/web/output/playwright/memory-flow.review.js`.

## Findings, ordered by user impact

| ID | Priority | Observed behavior and evidence | User impact | Recommended change |
| --- | --- | --- | --- | --- |
| M1 | P1 | Choosing Disconnect immediately calls the API. During a synthetic 1.5-second request there is no confirmation dialog or status region. Success is only announced with `sr-only` text. Browser: `memory-review-disconnecting-390.png`. Source: `ContextTreeCard` and `run`. | An accidental choice changes the Agent's knowledge sources without an explanation or recovery opportunity; a slow response looks inactive. | Confirm the exact source and impact, default focus to Cancel, show Disconnecting on the affected source, and keep the outcome visible. Explain that the GitHub repository and preserved work are not deleted. Preserve the existing pause/revision requirements. Do not invent an automatic Undo that could silently restore a changed source. |
| M2 | P1 | `publication_uncertain` retains the draft, but presents a long red technical paragraph, no repository link, and an enabled primary Create and connect button. Browser: `memory-review-uncertain-390.png`. | The strongest action encourages repetition while the remote outcome needs checking. The user must manually navigate to GitHub and reconstruct the next step. | Make uncertainty an explicit recovery state. Offer Open repository and Connect existing with the submitted repository prefilled. Retain the valid draft and explain how to handle an empty repository in secondary help. Avoid promoting unchanged creation as the default recovery. Preserve the prohibition on automatic repeated creation. |
| M3 | P1 | With connected sources, an active Agent, and an offline Computer, the banner says Disconnect remains available while offline, but Disconnect has `aria-disabled=true`. Online/active says to pause, but offers no destination. Browser: `memory-review-offline-disabled-390.png`. Source: `contextTreeStatusMessage` prioritizes offline over `pauseRequired`. | The page gives contradictory instructions and leaves disabled actions unexplained at their point of use. | Compute the complete restriction state. Explain pause whenever required, and separately explain offline restrictions on connect/create. Link to the existing Manage or Computer destination. Keep disconnect available while paused/offline. Never pause the Agent automatically. |
| M4 | P1 | Cancel returns focus correctly after the dialog closes. After the first successful connection and simulated config refresh, focus remains on BODY even after the dialog finishes closing and a 1.5-second focus recovery window. Last-source disconnect also leaves BODY focused. | Keyboard and assistive-technology users lose their position when the triggering element disappears. | After first connection, focus Add tree or the new source's meaningful action. After removal, focus the next source, previous source, or the empty-state primary action. Use the feature's stable fallback refs and wait for the actual rendered collection. Do not treat cancel-only focus coverage as mutation coverage. |
| M5 | P1 | Code path: `ContextTreePage` passes config failures to `AsyncState`, whose error state contains only the error message and no Retry. It supplies no background-error projection, so a failed config refresh replaces the form with the error surface. | A temporary read failure can remove the connection form and its local draft, with no direct recovery action. | Keep the page heading and a correctly shaped loading surface. Add explicit read retry. With an already loaded config, preserve the visible draft during transient refresh failures and show a stale-data notice. Preserve terminal 401/403/404/410 handling. Retain server revision checks for all writes. Verify this in the actual page/query composition; this finding was traced in code, not reproduced against a deployed read failure. |
| M6 | P2 | Invalid `../outside` focuses Directory and renders a separate alert, but the field has neither `aria-invalid` nor `aria-describedby`. Required repository errors do receive a description through Kumo. Browser: `memory-review-directory-error-390.png`. | The Directory error is detached from the field when the user revisits it; accessibility behavior differs between fields in the same form. | Render the directory failure through the existing Field error seam, attach its description, and set its invalid state. Keep focus on the first invalid field and make the error clear when revisiting it. |
| M7 | P2 | Authentication failures tell the user to use Account settings, but render no link. Recovery messages for missing capability, permissions, and stale configuration are plain text. Cloud repeats Account authorization guidance before an error. Browser: `memory-review-auth-390.png`; remaining message branches inspected in code. | Recovery requires remembering instructions, closing the dialog, finding another page, and reconstructing the attempted connection. | Show one error explanation and its relevant action: Account settings, GitHub repository, Computer settings, or refresh current config. Preserve valid input during in-app mode changes and ordinary retries. State the reload/external-authorization draft boundary explicitly; do not store sensitive state just to retain a form. |
| M8 | P2 | A normal GitHub folder link such as `.../tree/main/docs`, including the format emitted by source cards, is rejected as an invalid repository URL before any API call. The form asks for a repository URL and separate Directory. | Users who paste the page they have open get a generic repository error without being told how to split the link. | Keep the current default-branch contract. Immediately explain that the repository root belongs in the link field and the relative folder belongs in Directory, with a concrete example. Supporting folder URLs is a separate feature: do not guess branch boundaries, especially for branch names containing slashes. |
| M9 | P2 | The page repeats Memory explanation, an Add a Context Tree or Connected trees heading, and per-row Connected badges. Header/action and collection use different width constraints. Chinese alternates Context Tree, knowledge tree, Agent, and intelligent-agent wording. The 390px connected view puts several header lines and Add tree above the actual source. | The source and the next meaningful action receive less emphasis than repetitive configuration labels. Page density and terminology feel different across states. | Reuse the shared Agent header, content frame, tokens, type scale, and Kumo controls. Keep one concise value sentence. Keep Add tree in the header across empty and populated states, matching Skills/MCP. Use one centered, borderless empty state with lightweight Connect existing and local-only Create new shortcuts, following Soul. With sources present, use a single collection surface with source identity, repository/path, branch, and a quiet action menu. Remove redundant headings or badges rather than shrinking text. |
| M10 | P3 | All sources are displayed as full cards. A 32-source long-name case fits horizontally but is very tall. There is no count/capacity indication before the server's limit error. Connected is always a saved-config label and does not represent runtime preparation. | Scale and runtime meaning become harder to understand; no actual production scroll-performance defect was measured. | Display an accurate source count and unobtrusive capacity guidance. Keep source identity recoverable even when names repeat. Keep any Connected label scoped to the saved selection. Do not invent Ready, Synced, last-updated times, or availability data absent from the existing contract. Evaluate a denser shared list composition before adding search or pagination. |

P1 means the next implementation should address it before aesthetic polish; it does not imply data deletion or a measured production incident. P3 is a lower-priority design consideration from a stress case.

## Unified page and state direction

The page should answer three things in reading order: which knowledge sources this Agent uses, whether an action is currently restricted, and the next available action. It remains a source-management page; reading or editing memory content is not added by this review.

| Surface | Proposed composition and behavior |
| --- | --- |
| Shared frame | Existing Agent navigation and page frame; existing Manrope/system Chinese typography, teal primary actions, neutral surfaces, slate keyboard focus, shared spacing/radii and Phosphor controls. Align header, collection, and feedback to the same content width. No new font, palette, icon set, nested card system, or feature-specific animation language. |
| First-use empty | Keep the same header Add tree entry as populated states, matching Skills/MCP. Below it, use the shared centered, borderless empty composition: light 32px icon, one empty-state heading, one sentence with Connect existing and Local-only Create new inline shortcuts, matching Soul. Each shortcut opens the corresponding existing form. Explain private-repository creation inside the create dialog. Avoid a second prominent action row or instructional cards. |
| Connected | Header title/short description plus Add tree; one source collection. Source title and exact repository/path remain the visual anchors. Branch is secondary metadata. GitHub opening remains a real external link with an accessible name. The source action menu holds Disconnect. |
| Restrictions | One contextual notice before the affected collection/action. Pause requirement remains visible even when offline; online restrictions describe connect/create only. Existing source links remain usable. Recovery links go to existing settings destinations. |
| Connect dialog | Repository link first, Directory second with an optional/root hint; branch is still resolved by the server. Initial focus on Repository. Clear field errors. One local explanation of the expected URL. Preserve the submitted source when switching from uncertain creation to Connect existing. |
| Create dialog | Owner, Repository name, and one clear explanation of private-repository creation. Keep Cloud's existing connect-only capability. Do not add branch selection or create-on-Cloud behavior. |
| Pending | Disable duplicate submissions, use the specific action's progress label, and keep valid fields visible. Keep the affected source identifiable during disconnect. Prevent dismissing an operation whose remote outcome is uncertain. Do not use simulated percentage progress. |
| Success | Close the completed dialog only after a confirmed operation. Refresh the real collection, show concise visible feedback in a stable location, and restore focus to an element that survives the transition. If refresh fails, distinguish confirmed operation success from unconfirmed collection refresh. |
| Ordinary failure | Keep draft and dialog, attach the problem to the correct field/action, and expose a direct retry or repair destination. Do not classify all errors as a missing GitHub login. |
| Uncertain creation | Explicitly say the result needs checking. Open repository and Connect existing are the useful actions. Explain empty-repository cleanup without suggesting automatic creation retries. |
| Disconnect | Confirm source and scope; Cancel is the safe default. Disconnect preserves the repository, cache, and unpublished work under the current contract. Show pending/result on the source and restore focus after collection changes. |
| Read loading/failure | Retain page identity, use existing SkeletonLine/Loader and resource-state patterns, add Retry, and preserve previously loaded usable content during transient refresh failures while marking it unconfirmed. |

Representative copy direction, subject to the repository's bilingual catalog review:

| Purpose | English | Simplified Chinese |
| --- | --- | --- |
| Page description | Connect shared knowledge for this Agent. | 为此 Agent 连接可共享的知识。 |
| Primary empty action | Connect existing | 连接已有知识树 |
| Local secondary action | Create new | 新建知识树 |
| Pause requirement | Pause this Agent to add or disconnect sources. | 添加或断开知识来源前，请先暂停此 Agent。 |
| Offline restriction | Bring the Computer online to connect or create a source. | 连接或创建知识来源需要电脑在线。 |
| Pending disconnect | Disconnecting… | 正在断开连接… |
| Uncertain creation | Check the repository before creating again. | 再次创建前，请先检查 GitHub 仓库。 |

Keep Context Tree as the product technology name where it helps identify the source. Review bilingual terminology together instead of renaming navigation or API concepts independently.

## Acceptance for the subsequent implementation

1. Reproduce and resolve M1–M8 through user-visible behavior, not private implementation assertions. Preserve existing connection identity, offline disconnect, revision checks, Cloud capability limits, and no-automatic-create-retry semantics.
2. Confirm the restrictions truth table: empty/active can connect while online; nonempty/active requires pause; paused/offline can disconnect but cannot connect/create; nonempty/active/offline never claims disconnect is available. Existing source links always remain usable where the config may still be shown.
3. Exercise first connect, additional connect, create, ordinary failure, unknown create result, stale revision, last/non-last disconnect, cancel, and retry. Use the real page/query composition to verify refresh failures and draft retention.
4. Verify focus after initial opening, invalid submission, cancel, successful first connection, unsuccessful operation, and last/non-last removal. Dialog and menu keyboard behavior must remain intact. All essential feedback must be available to sighted and screen-reader users.
5. Run the complete application-shell view in English and Chinese at 320, 390, 768, and 1440px; inspect screenshots for readable copy, stable action placement, long repository/path/branch names, and no page-level overflow. Check browser zoom and reduced motion. Current isolated-fixture success does not complete this step.
6. Retain the exact source, error, and pending context while interacting. No simulated runtime-ready status, no hidden side effects, and no layout shift as the only outcome signal. Use existing shared motion; no artificial loading delay.
7. Run focused Memory behavior tests, affected Web type checks, required repository checks, and the relevant build. Once a reviewed version is available, complete an authenticated dev acceptance pass including actual GitHub permission/connection outcomes. Do not create production repositories just to obtain a screenshot.

## Source anchors

- [Memory page/query composition](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/agents/context-tree-page.tsx#L10)
- [Restriction and operation state](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/agents/agent-settings/context-tree-settings.tsx#L70)
- [Collection and empty-state composition](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/agents/agent-settings/context-tree-settings.tsx#L205)
- [Disconnect action](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/agents/agent-settings/context-tree-settings.tsx#L341)
- [Connection fields](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/agents/agent-settings/context-tree-settings.tsx#L402)
- [Repository URL parser and error mapping](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/agents/agent-settings/context-tree-settings.tsx#L546)
- [Resource read/error behavior](https://github.com/first-tree-ai/opentag/blob/7eecce24/apps/web/src/features/resource/resource-state.tsx#L103)
- [Existing connection and runtime contract](https://github.com/first-tree-ai/opentag/blob/7eecce24/docs/system/capabilities/context-tree-integration.md)
- [Shared Web UI contract](https://github.com/first-tree-ai/opentag/blob/7eecce24/docs/system/web/web-ui-contract.md)
- [Shared design direction](https://github.com/first-tree-ai/opentag/blob/7eecce24/docs/system/web/design.md)


## Existing-tab reuse decision

Follow-up requested by Gandy on 2026-10-23: compare other Agent tabs and identify concrete patterns to reuse. Compared the current source for Soul, Skills, MCP, and Settings, plus repository-owned browser acceptance screenshots. Historical screenshots contain older palette and navigation variants; they illustrate composition, not the current token values or a fresh deployed run.

The best fit is the Skills/MCP resource-management frame, Soul empty-state composition, and Soul/Skills operation feedback. This refines the earlier empty-state direction: Add tree remains in the header in both empty and populated states. Lightweight inline empty-state shortcuts can open the same forms, just as Soul keeps Browse templates in its header and offers an inline template shortcut.

| Reference | Existing evidence | Apply to Memory |
| --- | --- | --- |
| Skills/MCP header | Both use the owned PageHeader block: title, concise description, and header actions; compact layouts wrap actions into the next line. | Reuse PageHeader and keep Add tree in a predictable position. Let the shared block own responsive spacing and typography. |
| Skills/MCP populated collection | Both use a single white `ui-surface` list with shared dividers; rows carry identity, useful secondary text, and restrained controls. | Put source identity first, repository/path below it, branch as secondary metadata, and low-frequency actions in the source menu. Replace separate roomy cards and repeated Connected headings/badges with one coherent collection. |
| Soul/Skills/MCP empty state | The same borderless centered pattern uses a light 32px icon, heading, short explanation, and bounded text width. Soul embeds its two first-use choices in the sentence. | Match that geometry. Offer Connect existing and Local-only Create new as lightweight shortcuts rather than two mini instructional columns. Preserve the header entry and clear keyboard focus. |
| MCP actionable recovery | The source row presents the relevant retry or authorization action beside the affected integration. | Keep connection errors associated with the exact tree/form, expose the correct Account/GitHub/Computer destination, and preserve valid input. Only display states supported by the Memory contract; MCP runtime/authorization fields do not exist on a tree connection. |
| Skills deletion focus | Skills retains the trigger and neighboring row controls, then returns focus to a surviving neighbor or the page when a row disappears. | Adapt that fallback selection to first connection and last/non-last disconnect; the old trigger alone is insufficient. |
| MCP removal confirmation | The existing confirmation dialog defaults focus to Cancel, shows progress, prevents duplicate submission, and keeps failures actionable. | Reuse that interaction pattern with Memory-specific impact copy: a source is disconnected while its repository and preserved work remain. |
| Soul footer feedback | Success feedback reserves its geometry after it disappears; errors and drafts remain available. | Show concise feedback near the operation in a stable location. Keep an actual refresh failure distinct from a confirmed operation, and avoid moving the page when a short notice expires. |
| Settings field/action conventions | Existing Field, Dialog, and save-action patterns define label/error associations and predictable Cancel/submit placement. | Reuse those seams for consistent field errors and dialog actions. Memory remains an immediate connect/create workflow, so it does not inherit a page-wide Save button. |

Source references at the reviewed baseline:

- `apps/web/src/components/kumo/page-header/page-header.tsx`
- `apps/web/src/features/skills/skills-page.tsx` (header, list, retry, and surviving focus target)
- `apps/web/src/features/mcp/mcp-page.tsx` and `mcp-server-card.tsx` (resource rows and relevant recovery action)
- `apps/web/src/features/mcp/mcp-server-dialogs.tsx` (safe confirmation focus and pending state)
- `apps/web/src/features/agents/agent-settings/soul-empty-state.tsx`
- `apps/web/src/features/agents/agent-settings/soul-footer.tsx`
- `apps/web/src/features/agents/agent-settings/settings-layout.tsx`

This comparison changes the proposed composition only. It does not claim a Memory implementation, a new browser run of the other tabs, or a deployed acceptance result.
