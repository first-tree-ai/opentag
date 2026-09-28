import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudePermissionRules,
  prepareCodexPermissionRules,
  preparePiPermissionHome,
} from "../providers/native-permissions.js";
import { PiRpcProcess } from "../providers/pi/rpc-wire.js";

describe("Native permission configuration", () => {
  it("preserves Pi model defaults without inheriting global extensions or packages", async () => {
    const source = await mkdtemp(join(tmpdir(), "opentag-pi-original-"));
    let home: string | undefined;
    try {
      const defaults = { defaultProvider: "anthropic", defaultModel: "custom-model", defaultThinkingLevel: "high" };
      await writeFile(
        join(source, "settings.json"),
        JSON.stringify({ ...defaults, extensions: ["untrusted-extension"], packages: ["untrusted-package"] }),
      );
      home = await preparePiPermissionHome("", source);
      expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual(defaults);
      expect(await readlink(join(home, "models.json"))).toBe(join(source, "models.json"));
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it("writes and replaces managed Codex prefix rules without following policy-directory symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-native-rules-"));
    try {
      await prepareCodexPermissionRules(root, '[{"pattern":["git","push"],"decision":"prompt"}]');
      const rules = await readFile(join(root, ".codex", "rules", "opentag.rules"), "utf8");
      expect(rules).toContain('prefix_rule(pattern=["lark-cli","im","+messages-reply"], decision="allow")');
      expect(rules).toContain('prefix_rule(pattern=["slack","api","chat.postMessage"], decision="allow")');
      expect(rules).toContain('prefix_rule(pattern=["git","push"], decision="prompt")');
      await prepareCodexPermissionRules(root, "");
      expect(await readFile(join(root, ".codex", "rules", "opentag.rules"), "utf8")).not.toContain(
        'pattern=["git","push"]',
      );
      await rm(join(root, ".codex"), { recursive: true });
      await symlink(root, join(root, ".codex"));
      await expect(prepareCodexPermissionRules(root, "")).rejects.toThrow("real directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit Claude restrictions alongside routine reply defaults", () => {
    expect(claudePermissionRules('{"ask":["Bash(slack *)"],"deny":["Bash(lark-cli *)"]}')).toMatchObject({
      allow: expect.arrayContaining(["Bash(lark-cli im +messages-reply *)", "Bash(slack api chat.postMessage *)"]),
      ask: ["Bash(slack *)"],
      deny: ["Bash(lark-cli *)"],
    });
  });

  it.each(["", '{"bash":{"lark-cli *":"deny"}}', '{"bash":"deny"}'])(
    "allows routine Pi replies while preserving custom bash restrictions: %s",
    async (rules) => {
      const home = await preparePiPermissionHome(rules, "/existing/pi");
      try {
        const { permission } = JSON.parse(
          await readFile(join(home, "extensions/pi-permission-system/config.json"), "utf8"),
        );
        if (rules.includes('"bash":"deny"')) expect(permission.bash).toBe("deny");
        else {
          expect(permission.bash["lark-cli im +messages-reply *"]).toBe("allow");
          expect(permission.bash["slack api chat.postMessage *"]).toBe("allow");
          if (rules) expect(Object.entries(permission.bash).at(-1)).toEqual(["lark-cli *", "deny"]);
          else expect(permission.bash["*"]).toBe("ask");
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("loads the real pinned Pi permission package over RPC offline with writable workspace defaults", async () => {
    const home = await preparePiPermissionHome('{"bash":{"*":"ask","git status":"allow"}}', "/existing/pi");
    let rpc: PiRpcProcess | undefined;
    try {
      const permission = JSON.parse(
        await readFile(join(home, "extensions/pi-permission-system/config.json"), "utf8"),
      ).permission;
      expect(permission).toMatchObject({
        read: "allow",
        write: "allow",
        edit: "allow",
        external_directory: "ask",
        "*": "ask",
        bash: { "*": "ask", "git status": "allow" },
      });
      expect(permission.path_write[`${home}/*`]).toBe("deny");
      expect(await readlink(join(home, "auth.json"))).toBe("/existing/pi/auth.json");
      const projectConfig = join(home, ".pi/extensions/pi-permission-system/config.json");
      await mkdir(dirname(projectConfig), { recursive: true });
      await writeFile(projectConfig, JSON.stringify({ yoloMode: true, permission: { "*": "allow", bash: "allow" } }));
      // Seed Pi's native temporary npm cache from the installed dev dependency: this exercises
      // the production npm source without public-network access or model credentials.
      const cache = join(
        home,
        "tmp/extensions/npm",
        createHash("sha256").update("npm-").digest("hex").slice(0, 8),
        "node_modules/@gotgenes",
      );
      await mkdir(cache, { recursive: true });
      const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@gotgenes/pi-permission-system"))));
      await symlink(packageRoot, join(cache, "pi-permission-system"));
      const binary = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
      rpc = new PiRpcProcess({
        command: process.execPath,
        args: [
          binary,
          "--mode",
          "rpc",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-session",
          "--no-approve",
          "--extension",
          "npm:@gotgenes/pi-permission-system@35.0.1",
        ],
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1" },
        requestTimeoutMs: 10_000,
      });
      const notifications: Readonly<Record<string, unknown>>[] = [];
      rpc.subscribe((message) => notifications.push(message));
      expect(await rpc.request({ type: "get_commands" })).toMatchObject({
        commands: expect.arrayContaining([expect.objectContaining({ name: "permission-system" })]),
      });
      await rpc.request({ type: "prompt", message: "/permission-system show" });
      expect(notifications).toContainEqual(
        expect.objectContaining({ method: "notify", message: expect.stringContaining("yoloMode=off") }),
      );
    } finally {
      await rpc?.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
