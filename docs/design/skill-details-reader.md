# Skill details reader

[简体中文](../zh-CN/design/skill-details-reader.md)

A Skill's summary cannot replace its instructions. Click the installed Skill's content area—name, description or
surrounding whitespace—to read the complete `SKILL.md` and switch to supporting files without leaving the management
page. The reader integrates with the Skills management layout merged in PR #820. A stretched native name button owns
this larger hit area; the switch and More menu remain separate siblings and retain their independent management actions.
The content area has a subtle hover fill and a visible keyboard focus outline, without an extra details action.
Names use 16px semibold text and descriptions use 14px regular text. Controls align with the name; in narrow content
containers the description spans the full width below the first row. The stretched trigger extends across that mobile
content region, with the independent control group layered above it. Description tooltips are enabled only for actual
horizontal overflow or two-line clamping, measured on text changes, element resizing and font loading. Browse remains
available as a lighter ghost action beside Add.

## Reading experience

The large, dismissible dialog keeps the Skill name, download and close actions visible. Multi-file packages have a
collapsible file navigation on desktop and a Kumo file selector below the header on mobile. Single-file packages omit
both. Navigation and document scrolling are independent; the dialog stays within the dynamic viewport.

Markdown has document-sized headings, bounded line length, GFM lists/tables, inline code and scrollable code blocks.
Frontmatter is available through a disclosure; Source preserves the full UTF-8 text, including Frontmatter and a BOM.
Package links open actual package members. Heading fragments scroll/focus the current document's heading. Scripts,
HTML, SVG and other UTF-8 files appear as escaped, unhighlighted source text. Binary/non-UTF-8 files and files above
256 KiB show a clear unavailable-preview state, with the complete archive still downloadable. Empty files have an
explicit empty state. There is no editor, sharing workflow, file execution, or automatic remote image loading.

The existing Kumo dialog owns focus trapping and Escape. It remains mounted between openings; focus returns to the
Skill-details trigger. Package links focus the new reading region after loading. File buttons and folder disclosures use
normal Tab/Enter/Space behavior; they are a navigation list, not an ARIA tree requiring a separate keyboard model.
The source, code and table scroll regions are keyboard accessible. Agent changes unmount the reader and cancel reads.

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

## Rendering boundary and validation

`react-markdown` and `remark-gfm` are existing dependencies. Raw HTML is skipped, unsafe URLs are neutralized, remote
images are represented as text, and local image links lead to their explicit unsupported preview state. Only HTTP(S)
and mailto links can open externally. Unknown relative links stay inert rather than navigating to application routes.
Source files are rendered as React text and cannot execute.

Unit coverage exercises real tar.gz fixtures, complete indexes beyond 500 entries, ownership, canonical paths, stale
hashes, corruption, decompression limits, binary/large/empty text, Markdown injection, navigation and delayed Agent reads.
Browser evidence and exact checks are recorded in [the UI evidence](../../apps/web/docs/ui/skill-reader/README.md).
