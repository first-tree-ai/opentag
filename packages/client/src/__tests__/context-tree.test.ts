import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ContextTreeExecFile,
  ContextTreeManager,
  contextTreeFailureCode,
  resolveContextTreePackage,
} from "../runtime/context-tree.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

const managed = { kind: "managed", name: "team-context-tree" } as const;
const treeReply = (treePath: string) => ({ schemaVersion: 1, tree: { kind: "local", path: treePath } });
const installReply = { installed: [], schemaVersion: 1, skipped: [], version: "0.1.8" };

/** Record a Computer's Context Tree target, the way `opentag context-tree connect` does. */
async function writeTarget(home: string, target: unknown): Promise<void> {
  const layout = resolveOpenTagHomeLayout(home);
  await mkdir(layout.config, { mode: 0o700, recursive: true });
  await writeFile(layout.contextTreeConfigFile, `${JSON.stringify({ schemaVersion: 1, target })}\n`, "utf8");
}

/**
 * One Computer: an OpenTag home holding `target` as its recorded Context Tree, a manager whose
 * packaged CLI is answered by `execFile`, and the Agent workspace path a Session would pass.
 */
async function computer(
  options: {
    target?: unknown;
    execFile?: ContextTreeExecFile;
    platform?: NodeJS.Platform;
    nodePath?: string;
    codexHome?: string;
    sessionStartBudgetMs?: number;
    failureCooldownMs?: number;
    packaged?: false;
  } = {},
): Promise<{ home: string; cwd: string; manager: ContextTreeManager }> {
  const home = await mkdtemp(join(tmpdir(), "opentag-context-tree-"));
  directories.push(home);
  if (options.target !== undefined) await writeTarget(home, options.target);
  const root = resolve(home, "pkg");
  const manager = new ContextTreeManager({
    home,
    contextTreePackage:
      options.packaged === false
        ? null
        : { root, cliPath: join(root, "dist", "cli", "index.mjs"), skillsPath: join(root, "skills") },
    platform: options.platform ?? "linux",
    ...(options.execFile ? { execFile: options.execFile } : {}),
    ...(options.nodePath ? { nodePath: options.nodePath } : {}),
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    ...(options.sessionStartBudgetMs === undefined ? {} : { sessionStartBudgetMs: options.sessionStartBudgetMs }),
    ...(options.failureCooldownMs === undefined ? {} : { failureCooldownMs: options.failureCooldownMs }),
  });
  return { home, cwd: resolve(home, "workspace"), manager };
}

/** A recorded exec seam that answers each Context Tree subcommand with one JSON line. */
function recording(responses: Readonly<Record<string, unknown>>): { execFile: ContextTreeExecFile; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    execFile: async (_file, args) => {
      // The first argument is the CLI path; the subcommand follows.
      calls.push(args.slice(1));
      const response = responses[args[1] ?? ""];
      if (response === undefined) throw new Error(`unexpected subcommand: ${args[1] ?? ""}`);
      return { stdout: `${JSON.stringify(response)}\n` };
    },
  };
}

/** How the CLI reports an operational failure: one JSON line on stdout with exit code 1. */
const exitOne =
  (payload: unknown): ContextTreeExecFile =>
  async () => {
    const error = new Error("exit 1") as NodeJS.ErrnoException & { stdout: string };
    error.stdout = `${JSON.stringify(payload)}\n`;
    throw error;
  };

const killed: ContextTreeExecFile = async () => {
  const error = new Error("killed") as NodeJS.ErrnoException & { killed: boolean };
  error.killed = true;
  throw error;
};

describe("ContextTreeManager", () => {
  it("reports unconfigured before any Computer target is recorded", async () => {
    const { cwd, manager } = await computer({
      execFile: async () => {
        throw new Error("the CLI must not run without a configured target");
      },
    });

    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "unconfigured" });
  });

  it("reports a missing package without running anything", async () => {
    const { cwd, manager } = await computer({ target: managed, packaged: false });

    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "unavailable", reason: "PACKAGE_MISSING" });
  });

  it("connects, installs both hosts, writes the shim, and caches the workspace result", async () => {
    const { execFile, calls } = recording({ connect: treeReply("/srv/trees/team"), install: installReply });
    const { home, cwd, manager } = await computer({ execFile, nodePath: "/opt/node/bin/node", target: managed });

    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/trees/team" });
    // `connect` already returns the resolved tree, so no separate `resolve` round-trip is needed.
    expect(calls).toEqual([
      ["connect", "team-context-tree", "--project-path", cwd],
      ["install", "--host", "claude", "--project", cwd],
      ["install", "--host", "codex"],
    ]);

    const shimPath = join(manager.binDirectory(), "context-tree");
    const shim = await readFile(shimPath, "utf8");
    expect(shim).toContain("'/opt/node/bin/node'");
    expect(shim).toContain(join(resolve(home, "pkg"), "dist", "cli", "index.mjs"));
    expect((await stat(shimPath)).mode & 0o777).toBe(0o700);

    // A second Session for the same Agent must not re-run the CLI.
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/trees/team" });
    expect(calls).toHaveLength(3);
  });

  it("activates a target recorded after start, and follows every target change", async () => {
    const calls: string[][] = [];
    // Answer `connect` from its own arguments, so the returned path proves which target ran.
    const execFile: ContextTreeExecFile = async (_file, args) => {
      calls.push(args.slice(1));
      const connect = args[1] === "connect";
      const treePath = args[args.indexOf("--tree-path") + 1] ?? "";
      return { stdout: `${JSON.stringify(connect ? treeReply(treePath) : installReply)}\n` };
    };
    const { home, cwd, manager } = await computer({ execFile });

    // `connect` only writes the config file, so an unconfigured answer must never be cached.
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "unconfigured" });

    await writeTarget(home, { kind: "path", path: "/srv/tree-a" });
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/tree-a" });

    // A Computer pointed at a different tree must not be served the previous one.
    await writeTarget(home, { kind: "path", path: "/srv/tree-b" });
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/tree-b" });
    expect(calls.filter(([subcommand]) => subcommand === "connect")).toHaveLength(2);

    // Pointing back at the first tree must reconnect as well: the intervening `connect` rewrote
    // this workspace's connection store, so an entry recorded for tree A no longer describes it.
    await writeTarget(home, { kind: "path", path: "/srv/tree-a" });
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/tree-a" });
    expect(calls.filter(([subcommand]) => subcommand === "connect")).toHaveLength(3);
  });

  it.each([
    [{ kind: "github", repository: "acme/shared-context" }, ["connect", "acme/shared-context"]],
    [{ kind: "path", path: "/srv/trees/shared" }, ["connect", "--tree-path", "/srv/trees/shared"]],
  ])("passes %j through as the CLI's own connect argument", async (target, expected) => {
    const { execFile, calls } = recording({ connect: treeReply("/srv/trees/shared"), install: installReply });
    const { cwd, manager } = await computer({ execFile, target });

    await expect(manager.ensureAgent(cwd)).resolves.toMatchObject({ status: "ready" });
    expect(calls[0]).toEqual([...expected, "--project-path", cwd]);
  });

  it.each([
    ["an error envelope at exit 1", exitOne({ error: { code: "DIRTY_TREE", message: "" }, ok: false }), "DIRTY_TREE"],
    // `verify` reports an unusable tree this way: exit 0, with no `error` object at all.
    [
      "a failure payload at exit 0",
      (async () => ({
        stdout: JSON.stringify({ findings: [{ code: "INVALID_TREE" }], ok: false }),
      })) as ContextTreeExecFile,
      "INVALID_TREE",
    ],
    ["output that is not JSON", (async () => ({ stdout: "not json at all\n" })) as ContextTreeExecFile, "CLI_FAILED"],
    ["a CLI killed at its deadline", killed, "TIMEOUT"],
  ])("degrades with the CLI's own code for %s", async (_label, execFile, reason) => {
    const { cwd, manager } = await computer({ execFile, target: managed });

    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "unavailable", reason });
  });

  it("does not retry a failed preparation during cooldown, and a target change clears it", async () => {
    let attempt = 0;
    const { home, cwd, manager } = await computer({
      target: managed,
      failureCooldownMs: 60_000,
      execFile: async (_file, args) => {
        attempt += 1;
        if (attempt === 1) throw new Error("boom");
        return { stdout: `${JSON.stringify(args[1] === "connect" ? treeReply("/srv/t") : installReply)}\n` };
      },
    });

    await expect(manager.ensureAgent(cwd)).resolves.toMatchObject({ status: "unavailable" });
    await expect(manager.ensureAgent(cwd)).resolves.toMatchObject({ status: "unavailable" });
    expect(attempt).toBe(1);

    await writeTarget(home, { kind: "path", path: "/srv/another-tree" });
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/t" });
  });

  it("returns PREPARING within the Session budget and caches the background result", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let connectCalls = 0;
    const { cwd, manager } = await computer({
      target: managed,
      sessionStartBudgetMs: 10,
      execFile: async (_file, args) => {
        if (args[1] === "connect") {
          connectCalls += 1;
          await gate;
        }
        return { stdout: `${JSON.stringify(args[1] === "connect" ? treeReply("/srv/t") : installReply)}\n` };
      },
    });

    await expect(Promise.all([manager.ensureAgent(cwd), manager.ensureAgent(cwd)])).resolves.toEqual([
      { status: "unavailable", reason: "PREPARING" },
      { status: "unavailable", reason: "PREPARING" },
    ]);
    expect(connectCalls).toBe(1);
    release();
    await vi.waitFor(
      async () => {
        await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath: "/srv/t" });
      },
      { interval: 5, timeout: 1_000 },
    );
  });

  it("degrades on a platform with no shim, and on unreadable configuration", async () => {
    const windows = await computer({ platform: "win32", target: managed });
    await expect(windows.manager.ensureAgent(windows.cwd)).resolves.toEqual({
      status: "unavailable",
      reason: "SHIM_UNAVAILABLE",
    });

    // A recorded target that has since been corrupted on disk.
    const corrupt = await computer({ packaged: false, target: managed });
    await writeFile(resolveOpenTagHomeLayout(corrupt.home).contextTreeConfigFile, "{ not json", "utf8");
    await expect(corrupt.manager.readConfig()).resolves.toBeUndefined();
    await expect(corrupt.manager.ensureAgent(corrupt.cwd)).resolves.toEqual({ status: "unconfigured" });
  });

  it("serializes concurrent workspace preparation, because the connection store has no lock", async () => {
    let active = 0;
    let overlapped = false;
    const { home, manager } = await computer({
      target: managed,
      execFile: async (_file, args) => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((done) => setTimeout(done, 1));
        active -= 1;
        return { stdout: `${JSON.stringify(args[1] === "connect" ? treeReply("/srv/t") : installReply)}\n` };
      },
    });

    const statuses = await Promise.all(
      ["a", "b", "c"].map((name) => manager.ensureAgent(resolve(home, "workspaces", name))),
    );

    expect(overlapped).toBe(false);
    // Sharing one tree across Agents is the point of the feature.
    expect(statuses).toEqual(statuses.map(() => ({ status: "ready", treePath: "/srv/t" })));
  });

  it("lets five workspaces leave Session start within one budget while preparation stays serialized", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const calls: string[][] = [];
    const { home, manager } = await computer({
      target: managed,
      sessionStartBudgetMs: 10,
      execFile: async (_file, args) => {
        calls.push(args.slice(1));
        if (args[1] === "connect") await gate;
        return { stdout: `${JSON.stringify(args[1] === "connect" ? treeReply("/srv/t") : installReply)}\n` };
      },
    });
    const workspaces = ["a", "b", "c", "d", "e"].map((name) => resolve(home, "workspaces", name));

    await expect(Promise.all(workspaces.map((cwd) => manager.ensureAgent(cwd)))).resolves.toEqual(
      workspaces.map(() => ({ status: "unavailable", reason: "PREPARING" })),
    );
    expect(calls.filter(([command]) => command === "connect").length).toBeLessThanOrEqual(1);

    release();
    await vi.waitFor(() => expect(calls.filter(([command]) => command === "connect")).toHaveLength(5), {
      interval: 5,
      timeout: 1_000,
    });
    await vi.waitFor(
      async () => {
        await expect(Promise.all(workspaces.map((cwd) => manager.ensureAgent(cwd)))).resolves.toEqual(
          workspaces.map(() => ({ status: "ready", treePath: "/srv/t" })),
        );
      },
      { interval: 5, timeout: 1_000 },
    );
  });

  it("records both ready and unavailable preparation outcomes durably", async () => {
    const ready = await computer({
      target: managed,
      execFile: recording({ connect: treeReply("/srv/t"), install: installReply }).execFile,
    });
    await expect(ready.manager.ensureAgent(ready.cwd)).resolves.toMatchObject({ status: "ready" });
    await expect(readFile(resolveOpenTagHomeLayout(ready.home).contextTreePreparationFile, "utf8")).resolves.toContain(
      '"status": "ready"',
    );

    const unavailable = await computer({ target: managed, execFile: exitOne({ error: { code: "NO_TREE" } }) });
    await expect(unavailable.manager.ensureAgent(unavailable.cwd)).resolves.toEqual({
      status: "unavailable",
      reason: "NO_TREE",
    });
    const record = JSON.parse(
      await readFile(resolveOpenTagHomeLayout(unavailable.home).contextTreePreparationFile, "utf8"),
    );
    expect(record).toMatchObject({
      schemaVersion: 1,
      target: "team-context-tree",
      status: "unavailable",
      reason: "NO_TREE",
    });
    expect(record.at).toEqual(expect.any(String));
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

describe("resolveContextTreePackage", () => {
  it("resolves the installed package, so the runtime dependency is really there", async () => {
    const resolved = resolveContextTreePackage();
    expect(resolved).toBeDefined();
    if (!resolved) return;
    await expect(stat(resolved.cliPath)).resolves.toMatchObject({});
    await expect(stat(join(resolved.skillsPath, "context-tree-read", "SKILL.md"))).resolves.toMatchObject({});
  });
});
