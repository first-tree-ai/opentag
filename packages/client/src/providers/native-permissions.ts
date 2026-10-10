import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveRuntimeSnapshot } from "@opentag/shared";

// Native parsers check every segment of compound commands against these prefixes.
const MESSAGING_COMMANDS: readonly (readonly string[])[] = [
  ["lark-cli", "--help"],
  ["lark-cli", "skills", "read"],
  ["lark-cli", "im", "--help"],
  ...[
    "+messages-send",
    "+messages-reply",
    "+messages-edit",
    "+messages-mget",
    "+messages-search",
    "+messages-read-status",
    "+message-read-users",
    "+messages-resources-download",
    "+chat-messages-list",
    "+threads-messages-list",
    "+chat-list",
    "+chat-search",
    "+chat-members-list",
  ].map((command) => ["lark-cli", "im", command]),
  ...["delete", "patch", "forward", "merge_forward", "read_status", "read_users"].map((command) => [
    "lark-cli",
    "im",
    "messages",
    command,
  ]),
  ...["create", "delete", "list", "batch_query"].map((command) => ["lark-cli", "im", "reactions", command]),
  ["lark-cli", "im", "chats", "get"],
  ["lark-cli", "im", "chat.members", "get"],
  ["lark-cli", "im", "files", "create"],
  ["lark-cli", "im", "images", "create"],
  ["slack", "--help"],
  ["slack", "api", "--help"],
  ...[
    "auth.test",
    "bots.info",
    "team.info",
    "users.info",
    "users.list",
    "conversations.info",
    "conversations.list",
    "conversations.history",
    "conversations.replies",
    "conversations.members",
    "conversations.open",
    "conversations.join",
    "chat.postMessage",
    "chat.update",
    "chat.delete",
    "chat.scheduleMessage",
    "chat.deleteScheduledMessage",
    "chat.scheduledMessages.list",
    "chat.getPermalink",
    "reactions.add",
    "reactions.get",
    "reactions.list",
    "reactions.remove",
    "files.info",
    "files.list",
    "files.getUploadURLExternal",
    "files.completeUploadExternal",
  ].map((method) => ["slack", "api", method]),
  // Slack attachment handles use a fixed origin and literal routing arguments.
  ["curl", "https://slack.com", "--request-target"],
  ["printenv", "OPENTAG_PROVIDER_ENV_FILE"],
  ["rg", "OPENTAG_PROVIDER_"],
  // Codex needs explicit rules for output helpers to keep messaging pipelines outside its network sandbox.
  ["head"],
  ["tail"],
  ["cat"],
  ["echo"],
  ["printf"],
  ["jq"],
  ["wc"],
  ["stat"],
  ["sleep"],
];

export function allowedCommandsForPolicy(snapshot: EffectiveRuntimeSnapshot): readonly string[] {
  return snapshot.execution.approvalPolicy === "on-request" ? (snapshot.execution.allowCommands ?? []) : [];
}

export function claudePermissionRules(commands: readonly string[]) {
  return {
    allow: [...MESSAGING_COMMANDS.map((command) => command.join(" ")), ...commands].map(
      (command) => `Bash(${command} *)`,
    ),
  };
}

export async function prepareCodexPermissionRules(cwd: string, commands: readonly string[]): Promise<void> {
  const rules = [
    ...MESSAGING_COMMANDS.map((pattern) => ({ pattern, decision: "allow" })),
    ...commands.map((command) => ({ pattern: command.split(" "), decision: "allow" })),
  ];
  const directory = join(cwd, ".codex");
  for (const path of [directory, join(directory, "rules")]) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(path)).isDirectory()) throw new Error("Codex permission directory must be a real directory");
  }
  const file = join(directory, "rules", "opentag.rules");
  await rm(file, { force: true });
  await writeFile(
    file,
    rules
      .map((rule) => `prefix_rule(pattern=${JSON.stringify(rule.pattern)}, decision=${JSON.stringify(rule.decision)})`)
      .join("\n"),
    { mode: 0o600, flag: "wx" },
  );
}
