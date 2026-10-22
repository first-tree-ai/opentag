---
title: "Skill details reader"
description: "Reading a Skill's full instructions and supporting files from the Skills management page, and its rendering boundary."
---

# Skill details reader

A Skill's summary cannot replace its instructions. Click the installed Skill's content area—name, description or
surrounding whitespace—to read the complete `SKILL.md` and switch to supporting files without leaving the management
page. A stretched native name button owns this larger hit area; the switch and delete button remain separate siblings
and retain their independent management actions. Downloads are available in the reader header only; the list has
no More menu. The delete button is always visible as a secondary-color Phosphor trash icon, with a neutral hover
surface, danger-color hover/focus feedback and the shared keyboard focus outline. A localized tooltip supplements
the Skill-specific accessible name. Compact icon buttons retain at least 44px touch targets below 768px.
Deletion opens an explicit confirmation with Cancel initially focused; pending requests prevent duplicate submission
and dismissal, and failures remain in the dialog for retry. Cancelling restores focus to the delete button. After a
confirmed deletion, focus moves to the next available row, the preceding row if needed, or the named Skills page
when empty. Neighbouring row targets are retained when confirmation opens, so pending toggles and background removals
cannot shift the focus destination onto a different row.
The content area has a subtle hover fill and a visible keyboard focus outline, without an extra details action.
The right action group preserves the switch-then-delete order and a consistent right inset. The switch retains
Kumo's visual track while a transparent 44px target and matching layout slot improve pointer/touch access. An 8px
gap separates its target from the delete button; no extra action labels or divider are added.
Names use 16px semibold text and descriptions use 14px regular text. Controls center against the content group
on wide containers and align with the name in narrow containers. In narrow content containers the description spans
the full width below the first row. The stretched trigger extends across that mobile content region, with the
independent control group layered above it. Descriptions stay on one line and truncate with an ellipsis, without a
tooltip; the reader shows the full description. The header keeps a single
outlined Import skill menu with Install from URL and Upload file. The empty state explains these two import methods
without repeating the action. Explore skills is temporarily hidden in both the header and empty state while the discovery
experience is being designed. The catalog component, translations and server APIs remain available for future integration.

## Reading experience

The large, dismissible dialog keeps the Skill name, download and close actions visible without a redundant details
eyebrow. Multi-file packages have fixed file navigation on desktop, with collapsible folders and an accessible name
but no visible section label. On mobile, one Kumo file selector replaces the current-file toolbar content rather than
adding a second row. Single-file packages omit navigation and keep a centered reading column. Navigation and document
scrolling are independent; the dialog stays within the dynamic viewport.

The full Skill description appears only above a successful, nonempty `SKILL.md` text preview. A localized inline
`Description:` prefix, smaller text and subdued color distinguish it from the original document. Supporting files,
loading, failures and unavailable previews do not repeat that description.

Markdown has document-sized headings, bounded line length, GFM lists/tables, inline code and scrollable code blocks.
It always uses the reading view, with Frontmatter omitted from the rendered body. There is no reading/source switch
or separate Frontmatter disclosure; downloading the archive retains the complete original files. Empty Markdown
bodies, including documents containing only Frontmatter, have an explicit empty state.
Package links open actual package members. Heading fragments scroll/focus the target heading, including after a
cross-file navigation or a repeated link to the already-selected document. Scripts,
HTML, SVG and other UTF-8 files appear as escaped, unhighlighted source text. Binary/non-UTF-8 files and files above
256 KiB show a clear unavailable-preview state, with the complete archive still downloadable. Empty files have an
explicit empty state. There is no editor, sharing workflow, file execution, or automatic remote image loading.

The existing Kumo dialog owns focus trapping and Escape. It remains mounted between openings; focus returns to the
Skill-details trigger. Package links focus the new reading region after loading. File buttons and folder disclosures use
normal Tab/Enter/Space behavior; they are a navigation list, not an ARIA tree requiring a separate keyboard model.
The file, code and table scroll regions are keyboard accessible. Agent changes unmount the reader and cancel reads.
If a file read reports a missing resource, the reader revalidates Skill availability before removing the download
action: a missing member alone does not prove the entire package is gone. A confirmed missing Skill also refreshes
the management list. Transient availability-check failures leave the original file error and download action intact.

## Account file-read contract

`GET /api/v1/agents/:agentId/skills/:skillId/file?path=SKILL.md&archiveSha256=<sha256>` returns JSON:

- `archiveSha256`: the requested content version;
- `path`: the canonical root-relative file path;
- `files`: every actual archive member's path and byte count, up to the existing 1,000-entry archive limit;
- `preview`: `{ status: "text", content }`, `{ status: "binary" }`, or `{ status: "too_large" }`.

This endpoint reuses Account ownership and exact Agent/Skill scoping, including deleted-Agent rejection. Disabled
Skills remain readable by their owner. It is not added to the Computer or Session runtime credential surfaces.
An expected hash that differs from the current row produces the existing revision-conflict error before storage is
read. Missing Skills/files use the existing not-found error. Responses use `Cache-Control: no-store`.

The server reads the canonical tar.gz object with a compressed-byte ceiling, checks exact length and SHA-256, and
reuses the upload reader's path, duplicate, link, entry-count, decompressed-payload and tar-stream limits. No files are
extracted to disk. Preview decoding is strict UTF-8 and rejects binary control bytes; oversized previews are never
silently truncated. The full index comes from that same verified archive, rather than the database's truncated
500-file management summary. No database migration is required.

The shared Zod schemas own the request and response types. Web query keys include Agent, Skill, expected hash and path;
package text is discarded from the query cache when the reader closes. A concurrent replacement refreshes the list and
asks the user to reopen the reader. A transient failure offers Retry and retains file navigation.

Archive inspection happens per requested file. This avoids new extracted-file storage or a persistent server cache,
but switching files re-reads and validates the bounded archive. A future cache must preserve content-addressed identity,
Account authorization and the same validation limits.

## Rendering boundary

`react-markdown` and `remark-gfm` are existing dependencies. Raw HTML is skipped, unsafe URLs are neutralized, remote
images are represented as text, and local image links lead to their explicit unsupported preview state. Only HTTP(S)
and mailto links can open externally. Unknown relative links stay inert rather than navigating to application routes.
Source files are rendered as React text and cannot execute.
