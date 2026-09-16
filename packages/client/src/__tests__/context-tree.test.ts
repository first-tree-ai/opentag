import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ContextTreeExecFile,
  ContextTreeManager,
  codexInstallSkipReason,
  contextTreeFailureCode,
  resolveContextTreePackage,
} from "../runtime/context-tree.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

async function fixture(
  options: {
    fail?: string;
    delay?: number;
    sessionStartBudgetMs?: number;
    packaged?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "opentag-context-tree-"));
  directories.push(home);
  const calls: string[][] = [];
  const execFile: ContextTreeExecFile = async (_file, args) => {
    calls.push([...args.slice(1)]);
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (options.fail) return { stdout: JSON.stringify({ error: { code: options.fail } }) };
    return {
      stdout: JSON.stringify(
        args[1] === "connect" ? { tree: { path: `/trees/${args[2]}` } } : { installed: [{ host: "codex" }] },
      ),
    };
  };
  const manager = new ContextTreeManager({
    home,
    environment: { HOME: home },
    execFile,
    contextTreePackage:
      options.packaged === false ? null : { root: home, cliPath: join(home, "cli.mjs"), skillsPath: home },
    sessionStartBudgetMs: options.sessionStartBudgetMs ?? 1000,
    failureCooldownMs: 100,
    platform: options.platform ?? "linux",
  });
  return { home, cwd: join(home, "agent"), manager, calls };
}

describe("per-Agent ContextTreeManager", () => {
  it("ignores legacy computer configuration and disconnects a disabled Agent without deleting memory", async () => {
    const { home, cwd, manager, calls } = await fixture();
    await mkdir(join(home, ".context-tree"));
    await writeFile(
      join(home, ".context-tree", "opentag.json"),
      JSON.stringify({ schemaVersion: 1, target: { kind: "managed", name: "legacy" } }),
    );
    expect(await manager.ensureAgent(cwd, "codex", null)).toEqual({ status: "unconfigured" });
    expect(calls).toEqual([["disconnect", "--project-path", cwd, "--json"]]);
    expect(await readFile(join(home, ".context-tree", "opentag.json"), "utf8")).toContain("legacy");
  });
  it("uses the selected repository and caches each workspace, repository and provider", async () => {
    const { cwd, manager, calls } = await fixture();
    expect(await manager.ensureAgent(cwd, "pi", "acme/memory")).toEqual({
      status: "ready",
      treePath: "/trees/acme/memory",
    });
    await manager.ensureAgent(cwd, "pi", "acme/memory");
    expect(calls).toHaveLength(1);
    await manager.ensureAgent(cwd, "codex", "acme/memory");
    expect(calls).toHaveLength(4);
    await manager.ensureAgent(cwd, "pi", "other/memory");
    await manager.ensureAgent(`${cwd}-other`, "pi", "acme/memory");
    expect(calls.filter(([command]) => command === "connect")).toHaveLength(4);
  });
  it("installs provider skills and a shim pinned to the current Node", async () => {
    const { cwd, manager, calls } = await fixture();
    await manager.ensureAgent(cwd, "claude-code", "acme/memory");
    expect(calls).toContainEqual(["install", "--host", "claude", "--project", cwd]);
    expect(calls).toContainEqual(["install", "--host", "codex"]);
    const shim = join(manager.binDirectory(), "context-tree");
    expect(await readFile(shim, "utf8")).toContain(process.execPath);
    expect((await stat(shim)).mode & 0o777).toBe(0o700);
  });
  it.each(["INVALID_TREE", "GITHUB_AUTH", "TIMEOUT"])("keeps failures optional and cools down %s", async (fail) => {
    const { cwd, manager, calls } = await fixture({ fail });
    expect(await manager.ensureAgent(cwd, "pi", "acme/memory")).toEqual({ status: "unavailable", reason: fail });
    await manager.ensureAgent(cwd, "pi", "acme/memory");
    expect(calls).toHaveLength(1);
    await manager.ensureAgent(cwd, "pi", "other/memory");
    expect(calls).toHaveLength(2);
  });
  it("returns within startup budget, shares pending work, and caches its terminal result", async () => {
    const { cwd, manager, calls } = await fixture({ delay: 40, sessionStartBudgetMs: 5 });
    const results = await Promise.all([
      manager.ensureAgent(cwd, "pi", "acme/memory"),
      manager.ensureAgent(cwd, "pi", "acme/memory"),
    ]);
    expect(results).toEqual(Array(2).fill({ status: "unavailable", reason: "PREPARING" }));
    await vi.waitFor(async () =>
      expect(await manager.ensureAgent(cwd, "pi", "acme/memory")).toMatchObject({ status: "ready" }),
    );
    expect(calls).toHaveLength(1);
  });
  it("serializes settings work and disconnect behind background preparation", async () => {
    const { cwd, manager, calls } = await fixture({ delay: 20, sessionStartBudgetMs: 2 });
    await manager.ensureAgent(cwd, "pi", "acme/memory");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const settings = manager.runExclusive(async () => {
      calls.push(["settings"]);
    });
    await manager.ensureAgent(cwd, "pi", null);
    await settings;
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await manager.runExclusive(async () => undefined);
    expect(calls.map(([command]) => command)).toEqual(["connect", "settings", "disconnect"]);
  });
  it.each([
    { packaged: false, reason: "PACKAGE_MISSING" },
    { platform: "win32" as const, reason: "SHIM_UNAVAILABLE" },
  ])("reports $reason", async (options) => {
    const { cwd, manager } = await fixture(options);
    expect(await manager.ensureAgent(cwd, "pi", "acme/memory")).toEqual({
      status: "unavailable",
      reason: options.reason,
    });
  });
});

describe("contextTreeFailureCode", () => {
  it.each([
    [{ schemaVersion: 1, tree: { path: "/t" } }, undefined],
    [{ ok: true, findings: [] }, undefined],
    [{ error: { code: "NO_CONNECTION", message: "" }, ok: false }, "NO_CONNECTION"],
    [{ findings: [{ code: "MISSING_INDEX" }], ok: false }, "MISSING_INDEX"],
    [{ findings: [], ok: false }, "INVALID_TREE"],
    [null, "CLI_FAILED"],
  ])("reads %j as %s", (payload, expected) => {
    expect(contextTreeFailureCode(payload)).toBe(expected);
  });
});

describe("codexInstallSkipReason", () => {
  it.each([
    // A successful host install.
    [{ installed: [{ host: "codex" }] }, undefined],
    // A skipped Codex host carries the CLI's own explanation.
    [
      { skipped: [{ host: "codex", reason: "/home/user/.codex does not exist." }] },
      "/home/user/.codex does not exist.",
    ],
    [{ skipped: [{ host: "codex", reason: "" }] }, "CODEX_NOT_INSTALLED"],
    [{ skipped: [{ host: "codex" }] }, "CODEX_NOT_INSTALLED"],
    [{ installed: [], skipped: [] }, "CODEX_NOT_INSTALLED"],
    // Non-object payloads cannot reach the manager (contextTreeFailureCode flags them first),
    // but the helper still fails closed rather than throwing on property access.
    [null, "CODEX_INSTALL_FAILED"],
    ["not-an-object", "CODEX_INSTALL_FAILED"],
  ])("reads %j as %s", (payload, expected) => {
    expect(codexInstallSkipReason(payload)).toBe(expected);
  });
});

describe("resolveContextTreePackage", () => {
  it("resolves the installed package, so the runtime dependency is really there", async () => {
    const resolved = resolveContextTreePackage();
    expect(resolved).toBeDefined();
    if (!resolved) return;
    await expect(stat(resolved.cliPath)).resolves.toMatchObject({});
    await expect(stat(join(resolved.skillsPath, "context-tree-read", "SKILL.md"))).resolves.toMatchObject({});
  });
});
