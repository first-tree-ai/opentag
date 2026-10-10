# IM content and attachment delivery

OpenTag preserves the visible structure and native resource identifiers of Slack and Feishu messages. An attachment-only
message is valid input even when the platform omits its plain-text body. Current delivery, steer, and bounded history
share one deterministic text projection; the existing non-empty Runtime text contract and older Client compatibility
remain intact.

Slack blocks and legacy attachments retain readable paragraphs, fields, lists, links, code, mentions, media references,
and tables. Feishu posts retain tagged/locale content, markdown fallback, and inline resources. A video body uses its
file key; its cover image is a separate image reference. Visible cards and share/forward content are retained when the
platform supplies them. Unknown or inaccessible content is labeled explicitly with a source-message readback path.
Slack routing collects mentions independently from the selected display body and retains the native `app_mention`
meaning. Image references using either `slack_file.id` or a documented Slack private/permalink URL resolve to stable
file IDs; private URLs are not treated as public downloads.

## Read attachments on demand

The Agent receives source-message identifiers, resource identifiers, media kind, filename, size and availability. No
attachment bytes, temporary download URL, OCR, document extraction, transcription or sampled frames are generated before
the Turn. Local and Cloud use the same text input and existing native CLI credentials/proxy.
The Client also renders bounded resource metadata from the existing wire field, so older Server requests and frozen
requests still expose their attachments without downloading them or changing their persisted payload/hash. OpenTag
ordinals are labeled separately from provider-native resource IDs and direct the Agent to source-message readback.

- Slack: `slack api files.info --json '{"file":"F..."}'` returns metadata. Download the returned private URL through the
  configured proxy using literal arguments and the existing scoped `curl` command. The CLI launcher loads credentials
  automatically; do not source the environment file. Re-query once if the execution-scoped
  download handle has expired. Public URLs use existing HTTP tools without adding Slack credentials.
- Feishu/Lark: `lark-cli im +messages-resources-download --message-id <id> --file-key <key> --type image|file --as bot
  --output ./attachment.bin`. Use `image` for image keys and `file` for files, audio and video bodies.
- A missing resource key or a truncated message can be resolved by a targeted native read of the original message. A
  readback may reflect later edits and must not be presented as the frozen historical revision.

File understanding depends on the Agent's installed tools. The existing Codex image-viewing tool is enabled so downloaded
images can be inspected. Unavailable tools, permissions, deleted files and unreadable formats must be reported honestly.
A failed resource read never authorizes replaying a Turn or repeating a provider mutation.

## Budgets and failure handling

The existing canonical and Runtime budgets are retained: 16 resources, 16 KiB text per message, 40 KiB history, and a
64 KiB frame. Native parsing is bounded by depth and node count. Text truncation respects UTF-8 boundaries and is visible;
native identifiers and the original message reference allow targeted readback. The managed resource-download endpoint's
25 MiB limit is separate from native CLI/proxy limits.

Unrecoverable empty content and deterministic fresh-request failures become terminal for that undispatched revision,
with bounded diagnostic codes and field paths. They do not produce a two-second retry loop. Mutable Runtime configuration
keeps its existing retry policy. Aggregate frame overflow is terminal only when the message envelope independently
exceeds the limit without the mutable Runtime snapshot. Already frozen dispatch payloads, hashes, accepted Turns and
report replay are unchanged.

## Validation

Regression tests cover attachment-only Local direct/steer and Cloud dispatch, resource-bearing history, structured
mentions, cards/posts, native media keys, duplicate references, resource overflow, UTF-8 boundaries, terminal validation,
and the absence of eager Client downloads. Native proxy tests cover private downloads and execution-scoped handles.
Staging acceptance additionally requires original-file hashes, actual Agent reads/answers, and provider-visible receipts
on the deployed Server/Client/Runner revision; a successful download or completed Turn alone does not prove understanding.
