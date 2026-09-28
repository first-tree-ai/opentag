import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudePermissionRulesSchema, CodexPermissionRulesSchema, PiPermissionRulesSchema } from "@opentag/shared";

// Native gates still inspect compound shell commands; only routine message writes are allowed.
const REPLY_COMMANDS = [
  ["lark-cli", "im", "+messages-reply"],
  ["lark-cli", "im", "+messages-send"],
  ["slack", "api", "chat.postMessage"],
] as const;

export function claudePermissionRules(rules: string) {
  const custom = ClaudePermissionRulesSchema.parse(rules.trim() ? JSON.parse(rules) : {});
  return {
    ...custom,
    allow: [...REPLY_COMMANDS.map((command) => `Bash(${command.join(" ")} *)`), ...(custom.allow ?? [])],
  };
}

export async function prepareCodexPermissionRules(cwd: string, rules: string): Promise<void> {
  const custom = CodexPermissionRulesSchema.parse(rules.trim() ? JSON.parse(rules) : []);
  const parsed = [...REPLY_COMMANDS.map((pattern) => ({ pattern, decision: "allow" })), ...custom];
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
    parsed
      .map((rule) => `prefix_rule(pattern=${JSON.stringify(rule.pattern)}, decision=${JSON.stringify(rule.decision)})`)
      .join("\n"),
    { mode: 0o600, flag: "wx" },
  );
}

export async function preparePiPermissionHome(rules: string, sourceHome?: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opentag-pi-permissions-")));
  try {
    const config = join(directory, "extensions", "pi-permission-system", "config.json");
    await mkdir(dirname(config), { recursive: true, mode: 0o700 });
    const custom = PiPermissionRulesSchema.parse(rules.trim() ? JSON.parse(rules) : {});
    const customBash = typeof custom.bash === "object" ? custom.bash : {};
    await writeFile(
      config,
      JSON.stringify({
        yoloMode: false,
        // Render enough evidence for the IM bridge to reject oversized requests before any truncation.
        promptMaxRows: 6001,
        promptFieldMaxWidth: 6001,
        permission: {
          "*": "ask",
          read: "allow",
          write: "allow",
          edit: "allow",
          grep: "allow",
          find: "allow",
          ls: "allow",
          skill: "allow",
          path: "allow",
          external_directory: "ask",
          ...custom,
          bash:
            typeof custom.bash === "string"
              ? custom.bash
              : {
                  ...Object.fromEntries(
                    [["*", "ask"], ...REPLY_COMMANDS.map((command) => [`${command.join(" ")} *`, "allow"])].filter(
                      ([pattern]) => pattern !== undefined && !(pattern in customBash),
                    ),
                  ),
                  ...customBash,
                },
          path_write: {
            ...(typeof custom.path_write === "object" ? custom.path_write : { "*": custom.path_write ?? "allow" }),
            [`${directory}/*`]: "deny",
          },
        },
      }),
      { mode: 0o600 },
    );
    // Keep authentication and custom models in their existing home; policy gets a private home.
    const original = sourceHome ?? join(homedir(), ".pi", "agent");
    const settingsText = await readFile(join(original, "settings.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (settingsText) {
      const settings = JSON.parse(settingsText) as Record<string, unknown>;
      const modelDefaults = Object.fromEntries(
        ["defaultProvider", "defaultModel", "defaultThinkingLevel"]
          .filter((key) => settings[key] !== undefined)
          .map((key) => [key, settings[key]]),
      );
      await writeFile(join(directory, "settings.json"), JSON.stringify(modelDefaults), { mode: 0o600 });
    }
    for (const name of ["auth.json", "models.json"]) await symlink(join(original, name), join(directory, name));
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
