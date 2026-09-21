import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextTreeConnection } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ContextTreeExecFile,
  ContextTreeManager,
  codexInstallSkipReason,
  contextTreeFailureCode,
  resolveContextTreePackage,
} from "../runtime/context-tree.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
const trees = [
  { alias: "team", repository: "acme/team" },
  { alias: "product", repository: "acme/product" },
] as const;

async function fixture(
  options: {
    failure?: string;
    delayAlias?: string;
    managed?: boolean;
    packageMissing?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "opentag-context-tree-"));
  directories.push(home);
  const calls: string[][] = [];
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  let attachments: ContextTreeConnection[] = [];
  let fail = options.failure;
  const execFile: ContextTreeExecFile = async (_file, args, execution) => {
    const command = args[1];
    calls.push([...args.slice(1)]);
    environments.push(execution.env);
    const alias = args[args.indexOf("--as") + 1] ?? "";
    if (command === "resolve")
      return {
        stdout: JSON.stringify({
          schemaVersion: 2,
          connections: attachments.map((entry) => ({
            alias: entry.alias,
            projectPath: home,
            ok: true,
            tree: { kind: "github", path: `/trees/${entry.alias}`, repository: entry.repository },
          })),
        }),
      };
    if (command === "disconnect") {
      attachments = attachments.filter((entry) => entry.alias !== args[args.indexOf("--tree") + 1]);
      return { stdout: JSON.stringify({ disconnected: true }) };
    }
    if (command === "connect") {
      if (alias === options.delayAlias) await new Promise((done) => setTimeout(done, 80));
      if (alias === "product" && fail) return { stdout: JSON.stringify({ error: { code: fail } }) };
      attachments = [...attachments.filter((entry) => entry.alias !== alias), { alias, repository: args[2] ?? "" }];
      return {
        stdout: JSON.stringify({
          schemaVersion: 2,
          alias,
          tree: { kind: "github", repository: args[2], path: `/trees/${alias}` },
        }),
      };
    }
    return { stdout: JSON.stringify({ installed: [{ host: "codex" }] }) };
  };
  const manager = new ContextTreeManager({
    home,
    environment: { HOME: home, GITHUB_TOKEN: "ambient" },
    execFile,
    contextTreePackage: options.packageMissing
      ? null
      : { root: home, cliPath: join(home, "cli.mjs"), skillsPath: home },
    managedCredentials: options.managed,
    sessionStartBudgetMs: options.delayAlias ? 30 : 1000,
    failureCooldownMs: 50,
    platform: options.platform ?? "linux",
  });
  return {
    home,
    cwd: join(home, "workspace"),
    calls,
    environments,
    manager,
    setFailure: (value?: string) => {
      fail = value;
    },
  };
}

describe("named Context Tree preparation", () => {
  it("connects each alias, caches the complete unordered set and installs skills once", async () => {
    const f = await fixture();
    expect(await f.manager.ensureAgent(f.cwd, "codex", trees)).toEqual({
      status: "configured",
      connections: trees.map((entry) => ({ ...entry, status: "ready", treePath: `/trees/${entry.alias}` })),
    });
    expect(f.calls.filter(([command]) => command === "install")).toHaveLength(2);
    await f.manager.ensureAgent(f.cwd, "codex", [...trees].reverse());
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(2);
    expect(f.calls.filter(([command]) => command === "install")).toHaveLength(2);
    expect(f.calls.filter(([command]) => command === "resolve")).toHaveLength(2);
    await f.manager.ensureAgent(f.cwd, "pi", trees);
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(4);
    expect(await readFile(join(f.manager.binDirectory(), "context-tree"), "utf8")).toContain(process.execPath);
  });
  it("disconnects only obsolete aliases, preserving the other attachment and legacy files", async () => {
    const f = await fixture();
    await mkdir(join(f.home, ".context-tree"));
    await writeFile(join(f.home, ".context-tree", "opentag.json"), "legacy");
    await f.manager.ensureAgent(f.cwd, "pi", trees);
    await f.manager.ensureAgent(f.cwd, "pi", [trees[1]]);
    expect(f.calls).toContainEqual(["disconnect", "--tree", "team", "--project-path", f.cwd, "--json"]);
    expect(await f.manager.ensureAgent(f.cwd, "pi", [])).toEqual({ status: "unconfigured" });
    expect(f.calls).toContainEqual(["disconnect", "--tree", "product", "--project-path", f.cwd, "--json"]);
    expect(await readFile(join(f.home, ".context-tree", "opentag.json"), "utf8")).toBe("legacy");
  });
  it("retains healthy results while failed aliases observe their retry cooldown", async () => {
    const f = await fixture({ failure: "GITHUB_AUTH" });
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees)).toMatchObject({
      connections: [{ status: "ready" }, { status: "unavailable", reason: "GITHUB_AUTH" }],
    });
    f.setFailure();
    await f.manager.ensureAgent(f.cwd, "pi", trees);
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(2);
    await new Promise((done) => setTimeout(done, 60));
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees)).toMatchObject({
      connections: [{ status: "ready" }, { status: "ready" }],
    });
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(3);
  });
  it("retains completed results on startup budget expiry and joins background work", async () => {
    const f = await fixture({ delayAlias: "product" });
    const results = await Promise.all([
      f.manager.ensureAgent(f.cwd, "pi", trees),
      f.manager.ensureAgent(f.cwd, "pi", trees),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        connections: [{ status: "ready" }, { status: "unavailable", reason: "PREPARING" }],
      });
    await f.manager.runExclusive(async () => undefined);
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees)).toMatchObject({
      connections: [{ status: "ready" }, { status: "ready" }],
    });
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(2);
  });
  it("serializes configuration changes behind unfinished preparation", async () => {
    const f = await fixture({ delayAlias: "product" });
    await f.manager.ensureAgent(f.cwd, "pi", trees);
    await f.manager.ensureAgent(f.cwd, "pi", []);
    await f.manager.runExclusive(async () => {
      f.calls.push(["settings"]);
    });
    expect(f.calls.map(([command]) => command)).toEqual([
      "resolve",
      "connect",
      "connect",
      "resolve",
      "disconnect",
      "disconnect",
      "settings",
    ]);
  });
  it.each([
    { packageMissing: true, reason: "PACKAGE_MISSING" },
    { platform: "win32" as const, reason: "SHIM_UNAVAILABLE" },
  ])("applies $reason to every configured alias", async (options) => {
    const f = await fixture(options);
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees)).toMatchObject({
      connections: trees.map((entry) => ({ ...entry, status: "unavailable", reason: options.reason })),
    });
  });
  it("reports no configured trees without requiring a working shim", async () => {
    const f = await fixture({ platform: "win32" });
    expect(await f.manager.ensureAgent(f.cwd, "codex", [])).toEqual({ status: "unconfigured" });
    expect(f.calls.map(([command]) => command)).toEqual(["resolve"]);
  });
  it("rechecks grants before cached results and removes revoked aliases without networking", async () => {
    const f = await fixture({ managed: true });
    const grant = (entries: readonly ContextTreeConnection[]) => ({
      OPENTAG_GITHUB_REPOSITORIES: JSON.stringify(
        entries.map((entry) => ({ fullName: entry.repository, role: "context_tree" })),
      ),
      GITHUB_TOKEN: undefined,
    });
    await f.manager.ensureAgent(f.cwd, "pi", trees, grant(trees));
    const previousConnects = f.calls.filter(([command]) => command === "connect").length;
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees, grant([trees[0]]))).toMatchObject({
      connections: [{ status: "ready" }, { status: "unavailable", reason: "GITHUB_PERMISSION" }],
    });
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(previousConnects);
    expect(f.calls).toContainEqual(["disconnect", "--tree", "product", "--project-path", f.cwd, "--json"]);
    expect(f.environments[0]).not.toHaveProperty("GITHUB_TOKEN");
    const callsBeforeMissingEnvironment = f.calls.length;
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees)).toMatchObject({
      connections: [{ reason: "AUTHENTICATION_REQUIRED" }, { reason: "AUTHENTICATION_REQUIRED" }],
    });
    expect(f.calls).toHaveLength(callsBeforeMissingEnvironment);
    expect(await f.manager.ensureAgent(f.cwd, "pi", trees, grant([trees[0]]))).toMatchObject({
      connections: [{ status: "ready" }, { reason: "GITHUB_PERMISSION" }],
    });
    expect(f.calls.filter(([command]) => command === "connect")).toHaveLength(previousConnects);
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
