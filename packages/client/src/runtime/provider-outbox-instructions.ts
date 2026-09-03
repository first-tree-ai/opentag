export type ProviderOutboxProvider = "feishu" | "slack";

export interface ProviderOutboxInstructionOptions {
  readonly actionInstruction: string;
  readonly provider: ProviderOutboxProvider;
  readonly target: Readonly<Record<string, unknown>>;
  readonly targetLabel: string;
}

export function buildProviderOutboxInstructions(options: ProviderOutboxInstructionOptions): readonly string[] {
  const providerCommand = options.provider === "feishu" ? "lark-cli" : "slack api";
  return [
    'Who reads your output: inside OpenTag, the "user" your underlying agent addresses — the reader of everything you produce apart from running a provider CLI command, including the text that closes this Turn — is the OpenTag runtime. This is your runtime console; ordinary output is not delivered to the IM participant.',
    `The IM participant is a separate audience. The official ${providerCommand} CLI is your outbox and the only path from this Turn to that audience.`,
    "The console addresses OpenTag; running the provider CLI performs the provider action. Describing a reply, reaction, or proactive message in your output only records it in OpenTag; it does not deliver it.",
    options.actionInstruction,
    `To write to this ${options.provider} conversation, load the credentials from $OPENTAG_PROVIDER_ENV_FILE in your shell, then use the official ${providerCommand} CLI directly.`,
    ...providerBodyInstructions(options.provider),
    "OpenTag has no message send, reply, or reaction interface, and you do not report provider send results to OpenTag.",
    "Use the provider-native identifiers below. Do not substitute an OpenTag Session or message ID.",
    "If a provider result is unknown, query the provider before deciding whether to retry.",
    `${options.targetLabel}: ${JSON.stringify(options.target)}`,
    `For version-specific commands and native formats, run ${options.provider === "feishu" ? "lark-cli im --help" : "slack api --help"}.`,
  ];
}

/** Fixed Slack-only native CLI guidance. Kept under 4 KiB so the managed prompt stays bounded. */
const SLACK_NATIVE_CLI_GUIDANCE = [
  "Use the native CLI as `slack api chat.postMessage --json '<json>'`. Pass exactly one JSON object; never key=value pairs, which form-encode the token into the request body.",
  "Do not pass --token, --app, --team, -w, --workspace, --config-dir, --skip-update, or other token, app, team, workspace, config, or update override flags. The launcher and environment already bind this Turn.",
  "Set channel to the supplied channelId. Thread placement is a Session policy decision: when the current context includes threadTs, that value is this Session's Slack thread_ts; otherwise messageTs identifies the source message you may thread from.",
  "Put the body in `text` (at most 4,000 characters) or `markdown_text` (at most 12,000 characters). Split longer content across multiple chat.postMessage calls rather than truncating silently.",
  "Post at most 1 message per second per channel. Mention users as `<@U...>` with provider-native user IDs.",
  "conversations.history and similar reads are rate-limited; query sparingly and do not poll in a tight loop.",
  "Never print credentials, tokens, or the environment file. CLI argv and command output are visible on the OpenTag runtime console.",
] as const;

function providerBodyInstructions(provider: ProviderOutboxProvider): readonly string[] {
  if (provider === "slack") return SLACK_NATIVE_CLI_GUIDANCE;
  return [
    "For lark-cli text and Markdown bodies, intended line breaks must reach the CLI as real newline characters; never write literal `\\n` sequences for layout.",
    "Before sending, inspect the body: if it has no real newline and contains two or more literal `\\n` sequences, treat it as malformed and rebuild it instead of sending. Do not blindly replace `\\n`, because code or prose may intentionally discuss that token.",
    "Keep rich or multiline bodies out of ordinary inline shell quoting. Populate a task-specific variable with shell-native, non-interpolating multiline syntax, then pass the variable as one quoted `--text` or `--markdown` argument.",
    "POSIX shell pattern:",
    "```bash",
    "IFS= read -r -d '' OPENTAG_LARK_BODY <<'EOF' || true",
    "first line",
    "",
    'second line with `code`, $variables, "quotes", and apostrophes',
    "EOF",
    'lark-cli ... --markdown "$OPENTAG_LARK_BODY"',
    "```",
    "PowerShell pattern:",
    "```powershell",
    "$OpenTagLarkBody = @'",
    "first line",
    "",
    'second line with `code`, $variables, "quotes", and apostrophes',
    "'@",
    "lark-cli ... --markdown $OpenTagLarkBody",
    "```",
    "Replace `...` with the version-specific lark-cli subcommand and provider-native target options before running it.",
  ];
}
