export type ProviderOutboxProvider = "feishu" | "slack";

export interface ProviderOutboxInstructionOptions {
  readonly actionInstruction: string;
  readonly provider: ProviderOutboxProvider;
  readonly target: Readonly<Record<string, unknown>>;
  readonly targetLabel: string;
}

export function buildProviderOutboxInstructions(options: ProviderOutboxInstructionOptions): readonly string[] {
  return [
    'Who reads your output: inside OpenTag, the "user" your underlying agent addresses — the reader of everything you produce apart from running a provider CLI command, including the text that closes this Turn — is the OpenTag runtime. This is your runtime console; ordinary output is not delivered to the IM participant.',
    options.provider === "feishu"
      ? "The IM participant is a separate audience. The official lark-cli CLI is your outbox and the only path from this Turn to that audience."
      : "The IM participant is a separate audience. The official slack api CLI is your outbox and the only path from this Turn to that audience.",
    "The console addresses OpenTag; running the provider CLI performs the provider action. Describing a reply, reaction, or proactive message in your output only records it in OpenTag; it does not deliver it.",
    options.actionInstruction,
    options.provider === "feishu"
      ? "To write to this Feishu conversation, run lark-cli directly. The launcher loads this Turn's credentials automatically; do not source $OPENTAG_PROVIDER_ENV_FILE before ordinary CLI commands."
      : "To write to this Slack conversation, run the official slack api CLI directly. The launcher loads this Turn's credentials automatically; do not source $OPENTAG_PROVIDER_ENV_FILE before ordinary CLI commands.",
    ...providerBodyInstructions(options.provider),
    ...providerAttachmentInstructions(options.provider),
    "Pass message bodies as quoted literal arguments or JSON. Plain CLI commands may be chained or piped to head, tail, cat, echo, printf, jq, wc, or stat, with sleep for rate limits; each command retains its own native permission check. Avoid shell variables, command substitutions, redirects, and heredocs for ordinary messaging commands.",
    "OpenTag has no hosted message send, reply, or reaction tool, and you do not report provider send results to OpenTag.",

    "Use the provider-native identifiers below. Do not substitute an OpenTag Session or message ID.",
    "If a provider result is unknown, query the provider before deciding whether to retry.",
    `${options.targetLabel}: ${JSON.stringify(options.target)}`,
    `For version-specific commands and native formats, run ${options.provider === "feishu" ? "lark-cli im --help" : "slack api --help"}.`,
  ];
}

/** Fixed Slack-only native CLI guidance. Kept under 4 KiB so the managed prompt stays bounded. */
export const SLACK_NATIVE_CLI_GUIDANCE_MAX_BYTES = 4 * 1024;

export const SLACK_NATIVE_CLI_GUIDANCE = [
  "Write with `slack api chat.postMessage --json '<json>'`. Pass exactly one JSON object. For reads (files.info, users.info/list, conversations read methods, reactions.get/list, team.info, chat.scheduledMessages.list), use `slack api <method> --data '<urlencoded parameters>'`; Slack legacy reads ignore JSON. Never supply token parameters; never key=value pairs as positional arguments.",
  "Do not pass --token, --app, --team, -w, --workspace, --config-dir, --skip-update, or other token, app, team, workspace, config, or update override flags. The launcher and environment already bind this Turn.",
  "Set channel to the supplied channelId. Thread placement is a Session policy decision: when the current context includes threadTs, that value is this Session's Slack thread_ts; otherwise messageTs identifies the source message you may thread from.",
  "You may discover, read, or write another public channel, private channel, DM, or existing MPIM with its provider-native ID when that conversation is relevant to the current task, even if the user did not name it. Otherwise stay in this Session's conversation. Do not roam through, bulk-join, or inspect task-unrelated conversations.",
  "Discover the Team, users, channels, DMs, and existing MPIMs with team.info, users.info, users.list, conversations.info, and conversations.list. Paginate list methods with limit and response_metadata.next_cursor; stop when the cursor is empty.",
  "Read a targeted channel with conversations.history and a thread with conversations.replies (channel plus ts). conversations.history and similar reads are rate-limited; query sparingly and do not poll in a tight loop. On HTTP 429, wait Retry-After seconds or a short backoff once before retrying.",
  "Post with chat.postMessage, edit with chat.update, delete with chat.delete, and schedule with chat.scheduleMessage. Cancel a scheduled message immediately by its scheduled_message_id with chat.deleteScheduledMessage, leave enough lead time, and verify it is absent with chat.scheduledMessages.list. Put the body in `text` (at most 4,000 characters) or `markdown_text` (at most 12,000 characters). Split longer content across multiple chat.postMessage calls rather than truncating silently. Post at most 1 message per second per channel. Mention users as `<@U...>` with provider-native user IDs.",
  "Open or resume a 1:1 DM with conversations.open `{users}` containing exactly one user ID. Do not use it to create an MPIM; read or write an existing MPIM only when the bot already has access.",
  "For not_in_channel, first confirm with conversations.info or conversations.list that the target is a public channel and relevant to the current task. Then call conversations.join `{channel}` once and retry the original action once. Joining enrolls future messages in normal OpenTag ingress: they are persisted, then mention_only or all_message controls delivery. Do not join merely to explore. For private channels, MPIMs, channel_not_found, or an unknown type, ask the user to invite the bot; do not guess or retry.",
  "Add, read, or remove emoji with reactions.add, reactions.get, and reactions.remove using channel, timestamp, and name.",
  "Upload files with Slack's current external flow only: files.getUploadURLExternal `{filename,length}` → HTTP POST the raw bytes to upload_url (not via slack api) → files.completeUploadExternal `{files:[{id,title}],channel_id,thread_ts?}`. Do not call the deprecated files.upload method.",
  "Never print credentials, tokens, or the environment file. CLI argv and command output are visible on the OpenTag runtime console.",
] as const;

function providerBodyInstructions(provider: ProviderOutboxProvider): readonly string[] {
  if (provider === "slack") return SLACK_NATIVE_CLI_GUIDANCE;
  return [
    "For lark-cli text and Markdown bodies, intended line breaks must reach the CLI as real newline characters; never write literal `\\n` sequences for layout.",
    "Before sending, inspect the body: if it has no real newline and contains two or more literal `\\n` sequences, treat it as malformed and rebuild it instead of sending. Do not blindly replace `\\n`, because code or prose may intentionally discuss that token.",
    "Use --text or --markdown with a single shell-quoted literal body, including real newlines. Protect apostrophes by ending the single quote, adding a double-quoted apostrophe, and reopening the single quote. Do not use ANSI-C quoting or shell substitutions to build the body.",
    "Example:",
    "```bash",
    "lark-cli im +messages-reply --message-id om_xxx --markdown 'First line\n\nSecond line'",
    "```",
    'Alternatively use --msg-type text --content \'{"text":"First line\\nSecond line"}\'. In JSON bodies, newline escapes are decoded by the provider; in --text and --markdown they are literal text. For a rich post, pass provider-native post JSON with --msg-type post --content. Split long replies into multiple messages instead of constructing a shell script.',
  ];
}

/** Non-secret execution metadata is discovered without changing native CLI authentication. */
export const GITHUB_NATIVE_CLI_INSTRUCTIONS =
  "GitHub integration, when enabled, preconfigures native git and gh. Read OPENTAG_GITHUB_REPOSITORIES for granted repositories, role, branch, publish mode and workBranchPrefix. Create task branches under the supplied workBranchPrefix; Context Tree direct mode targets its configured branch. Authentication and renewal are automatic; do not run interactive login or replace managed credentials.";

/** On-demand reads support both default Local credentials and the Cloud credential proxy. */
function providerAttachmentInstructions(provider: ProviderOutboxProvider): readonly string[] {
  const common = [
    "Incoming attachments are references, not downloaded files. Read them only when the task needs them. Run the provider CLI directly; the launcher loads this Turn's credentials automatically. Never print credentials or the environment file.",
    "The source message and attachment IDs are provider-native. If the input is truncated or an older Server supplied only OpenTag resource ordinals, query the original provider message to discover its resources. A message readback can reflect later edits; do not present it as the frozen historical version.",
    "A failed attachment read does not authorize replaying the Turn or repeating a send. Report deleted, inaccessible, unsupported, or unreadable content accurately; do not invent its contents.",
  ];
  if (provider === "slack")
    return [
      ...common,
      "For a Slack file_id, run `slack api files.info --data 'file=F...'`. Check ok, then download url_private_download (or url_private) to a workspace file using the matching credential path below. files.info returns metadata, not file bytes. URL-encode parameter values, including spaces, &, and Unicode. Use conversations.history with channelId and messageTs for source messages, or conversations.replies with channelId and threadTs for a thread.",
      "For raw attachment requests, run `printenv OPENTAG_PROVIDER_ENV_FILE`, then `rg '^export OPENTAG_(PROVIDER_(PROXY_URL|CA_PATH)|SLACK_DOWNLOAD_CONFIG)=' '<returned path>'` to read only nonsecret routing/config paths. Do not read the download config, source the environment, add authorization headers, or use shell substitutions.",
      "When proxy URL and CA are present, use literal values in `curl https://slack.com --request-target '/__opentag__/handles/<id>' --proxy '<proxy URL>' --cacert '<CA path>' --noproxy '' --fail --silent --show-error`. Copy the handle path from upload_url, url_private, or url_private_download. Upload with --request POST --data-binary @<file>; download with --output <file>.",
      "Otherwise, for Local credentials, use `curl --disable --config '<OPENTAG_SLACK_DOWNLOAD_CONFIG path>' --fail --silent --show-error '<url_private_download>' --output <file>` only for HTTPS files.slack.com URLs returned by files.info. The private Turn config supplies authentication; never print it or use verbose/trace/header output or redirect flags. Public URLs and native upload_url requests use existing HTTP tools without this config or Slack credentials.",
      "Private download handles and Turn configs expire. Re-query files.info once if expired; retry only the read. Do not poll or bulk-fetch unrelated messages.",
    ];
  return [
    ...common,
    "For Feishu/Lark attachments, run `lark-cli im +messages-resources-download --message-id <messageId> --file-key <key> --type image|file --as bot --output ./attachment.bin`. Use image for image_key, file for files/audio/video file_key, and a workspace-relative output path. The video body and cover have different keys. Use `lark-cli im --help` for source-message reads in the installed version; retain the configured bot identity and do not log in interactively.",
  ];
}
