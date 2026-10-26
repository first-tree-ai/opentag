import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudePermissionRules, prepareCodexPermissionRules } from "../providers/native-permissions.js";

const messagingPrefixes = [
  ["lark-cli", "im", "+messages-reply"],
  ["lark-cli", "im", "+chat-messages-list"],
  ["lark-cli", "im", "+messages-resources-download"],
  ["slack", "api", "conversations.history"],
  ["slack", "api", "conversations.replies"],
  ["slack", "api", "chat.postMessage"],
  ["slack", "api", "chat.update"],
  ["slack", "api", "files.getUploadURLExternal"],
  ["slack", "api", "files.completeUploadExternal"],
  ["curl", "https://slack.com", "--request-target"],
  ["printenv", "OPENTAG_PROVIDER_ENV_FILE"],
  ["rg", "OPENTAG_PROVIDER_"],
  ["head"],
  ["jq"],
  ["wc"],
  ["stat"],
  ["sleep"],
  ["opentag-dev"],
  ["opentag-staging"],
  ["opentag"],
  ["context-tree"],
];

describe("Native permission configuration", () => {
  it.each([
    ["/opt/current node/bin/node", "/opt/owner's app/cli/index.mjs"],
    ["/opt/owner's portable/bin/opentag-staging"],
  ])("matches the exact managed CLI invocation %j through both provider gates", async (...invocation) => {
    const root = await mkdtemp(join(tmpdir(), "opentag-managed-cli-rules-"));
    try {
      const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
      const command = invocation.map(quote).join(" ");
      const claude = claudePermissionRules([], invocation).allow;
      expect(claude).toContain(`Bash(${command} *)`);
      const rule = claude.find((value) => value === `Bash(${command} *)`);
      expect(`${command} session send target`).toMatch(
        new RegExp(`^${rule?.slice(5, -3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `),
      );
      await prepareCodexPermissionRules(root, [], invocation);
      const codex = await readFile(join(root, ".codex/rules/opentag.rules"), "utf8");
      expect(codex).toContain(`prefix_rule(pattern=${JSON.stringify(invocation)}, decision="allow")`);
      if (invocation.length > 1) expect(codex).not.toContain(`pattern=${JSON.stringify([invocation[0]])}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [],
    ["node", "/app/cli.mjs"],
    ["/bin/node", ""],
    ["/bin/no*de"],
    ["/bin/node", "bad\nentry"],
    ["/bin/node", "bad\0entry"],
  ])("rejects nonliteral or nonabsolute managed invocation %j", async (...invocation) => {
    expect(() => claudePermissionRules([], invocation)).toThrow("absolute executable");
    const root = await mkdtemp(join(tmpdir(), "opentag-invalid-managed-cli-"));
    try {
      await expect(prepareCodexPermissionRules(root, [], invocation)).rejects.toThrow("absolute executable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows message reads, writes, attachments, and compound-command helpers through both native gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-native-rules-"));
    try {
      const claude = claudePermissionRules(["git status"]).allow;
      await prepareCodexPermissionRules(root, ["git status"]);
      const codex = await readFile(join(root, ".codex", "rules", "opentag.rules"), "utf8");
      for (const pattern of [...messagingPrefixes, ["git", "status"]]) {
        expect(claude).toContain(`Bash(${pattern.join(" ")} *)`);
        expect(codex).toContain(`prefix_rule(pattern=${JSON.stringify(pattern)}, decision="allow")`);
      }
      expect(claude).not.toContain("Bash(slack api *)");
      expect(claude).not.toContain("Bash(lark-cli *)");
      expect(codex).not.toContain('pattern=["slack","api"]');
      expect(codex).not.toContain('pattern=["lark-cli"]');
      await prepareCodexPermissionRules(root, []);
      expect(await readFile(join(root, ".codex", "rules", "opentag.rules"), "utf8")).not.toContain(
        'pattern=["git","status"]',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects policy-directory symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-native-rules-"));
    try {
      await symlink(root, join(root, ".codex"));
      await expect(prepareCodexPermissionRules(root, [])).rejects.toThrow("real directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
