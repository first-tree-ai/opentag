import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContextTreeExecFile,
  ContextTreeManager,
  type ContextTreePackage,
  contextTreeFailureCode,
  resolveContextTreePackage,
} from "../runtime/context-tree.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

async function temporaryHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  directories.push(home);
  return home;
}

function fixturePackage(root: string): ContextTreePackage {
  return { root, cliPath: join(root, "dist", "cli", "index.mjs"), skillsPath: join(root, "skills") };
}

async function writeConfig(home: string, target: unknown): Promise<void> {
  const layout = resolveOpenTagHomeLayout(home);
  await mkdir(layout.config, { mode: 0o700, recursive: true });
  await writeFile(layout.contextTreeConfigFile, `${JSON.stringify({ schemaVersion: 1, target })}\n`, "utf8");
}

/** A recorded exec seam that answers each Context Tree subcommand with one JSON line. */
function recordingExecFile(responses: Readonly<Record<string, unknown>>): {
  execFile: ContextTreeExecFile;
  calls: string[][];
} {
  const calls: string[][] = [];
  const execFile: ContextTreeExecFile = async (_file, args) => {
    // The first argument is the CLI path; the subcommand follows.
    calls.push(args.slice(1));
    const response = responses[args[1] ?? ""];
    if (response === undefined) throw new Error(`unexpected subcommand: ${args[1] ?? ""}`);
    if (response instanceof Error) throw response;
    return { stdout: `${JSON.stringify(response)}\n` };
  };
  return { execFile, calls };
}

/** How the CLI reports an operational failure: one JSON line on stdout with exit code 1. */
function cliFailure(code: string): NodeJS.ErrnoException & { stdout: string } {
  const error = new Error("exit 1") as NodeJS.ErrnoException & { stdout: string };
  error.stdout = `${JSON.stringify({ error: { code, message: code }, ok: false, schemaVersion: 1 })}\n`;
  return error;
}

const treeReply = (treePath: string) => ({ schemaVersion: 1, tree: { kind: "local", path: treePath } });
const installReply = { installed: [], schemaVersion: 1, skipped: [], version: "0.1.7" };

describe("ContextTreeManager", () => {
  it("reports unconfigured before any Computer target is recorded", async () => {
    const home = await temporaryHome("opentag-context-tree-unconfigured-");
    const manager = new ContextTreeManager({
      home,
      contextTreePackage: fixturePackage(resolve(home, "pkg")),
      execFile: async () => {
        throw new Error("the CLI must not run without a configured target");
      },
    });

    await expect(manager.ensureAgent(resolve(home, "workspace"))).resolves.toEqual({ status: "unconfigured" });
  });

  it("reports a missing package without running anything", async () => {
    const home = await temporaryHome("opentag-context-tree-no-package-");
    await writeConfig(home, { kind: "managed", name: "team-context-tree" });
    const manager = new ContextTreeManager({ home, contextTreePackage: null });

    await expect(manager.ensureAgent(resolve(home, "workspace"))).resolves.toEqual({
      status: "unavailable",
      reason: "PACKAGE_MISSING",
    });
  });

  it("connects, installs both hosts, writes the shim, and caches the workspace result", async () => {
    const home = await temporaryHome("opentag-context-tree-ready-");
    const treePath = resolve(home, "trees", "team-context-tree");
    await writeConfig(home, { kind: "managed", name: "team-context-tree" });
    const { execFile, calls } = recordingExecFile({ connect: treeReply(treePath), install: installReply });
    const manager = new ContextTreeManager({
      home,
      contextTreePackage: fixturePackage(resolve(home, "pkg")),
      execFile,
      nodePath: "/opt/node/bin/node",
      platform: "linux",
    });
    const cwd = resolve(home, "workspace");

    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath });
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
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath });
    expect(calls).toHaveLength(3);
  });

  it("passes the target through per kind and clones a GitHub target on first use", async () => {
    for (const [target, expected] of [
      [{ kind: "github", repository: "acme/shared-context" }, ["connect", "acme/shared-context"]],
      [{ kind: "path", path: "/srv/trees/shared" }, ["connect", "--tree-path", "/srv/trees/shared"]],
    ] as const) {
      const home = await temporaryHome("opentag-context-tree-target-");
      await writeConfig(home, target);
      const { execFile, calls } = recordingExecFile({ connect: treeReply("/srv/trees/shared"), install: installReply });
      const manager = new ContextTreeManager({
        home,
        contextTreePackage: fixturePackage(resolve(home, "pkg")),
        execFile,
        platform: "linux",
      });
      const cwd = resolve(home, "workspace");

      await expect(manager.ensureAgent(cwd)).resolves.toMatchObject({ status: "ready" });
      expect(calls[0]).toEqual([...expected, "--project-path", cwd]);
    }
  });

  it.each([
    ["an error envelope with exit code 1", cliFailure("DIRTY_TREE"), "DIRTY_TREE"],
    ["an unauthenticated GitHub target", cliFailure("GITHUB_AUTH"), "GITHUB_AUTH"],
    // `verify` reports an unusable tree this way, with no `error` object at all.
    ["a zero-exit failure payload", { findings: [{ code: "INVALID_TREE" }], ok: false }, "INVALID_TREE"],
    ["output that is not JSON", { unparseable: true }, "CLI_FAILED"],
  ])("surfaces the CLI's own code for %s", async (_label, response, reason) => {
    const home = await temporaryHome("opentag-context-tree-failure-");
    await writeConfig(home, { kind: "managed", name: "team-context-tree" });
    const badJson = typeof response === "object" && "unparseable" in response;
    const manager = new ContextTreeManager({
      home,
      contextTreePackage: fixturePackage(resolve(home, "pkg")),
      execFile: badJson
        ? async () => ({ stdout: "not json at all\n" })
        : recordingExecFile({ connect: response }).execFile,
      platform: "linux",
    });

    await expect(manager.ensureAgent(resolve(home, "workspace"))).resolves.toEqual({
      status: "unavailable",
      reason,
    });
  });

  it("reports a timeout rather than waiting on a hung CLI", async () => {
    const home = await temporaryHome("opentag-context-tree-timeout-");
    await writeConfig(home, { kind: "managed", name: "team-context-tree" });
    const manager = new ContextTreeManager({
      home,
      contextTreePackage: fixturePackage(resolve(home, "pkg")),
      execFile: async () => {
        const error = new Error("killed") as NodeJS.ErrnoException & { killed: boolean };
        error.killed = true;
        throw error;
      },
      platform: "linux",
    });

    await expect(manager.ensureAgent(resolve(home, "workspace"))).resolves.toEqual({
      status: "unavailable",
      reason: "TIMEOUT",
    });
  });

  it("degrades rather than throwing, and retries a failure on the next Session", async () => {
    const home = await temporaryHome("opentag-context-tree-retry-");
    const treePath = resolve(home, "tree");
    await writeConfig(home, { kind: "managed", name: "team-context-tree" });
    let attempt = 0;
    const manager = new ContextTreeManager({
      home,
      contextTreePackage: fixturePackage(resolve(home, "pkg")),
      execFile: async (_file, args) => {
        attempt += 1;
        // The first attempt fails in a way the manager does not anticipate at all.
        if (attempt === 1) throw new Error("boom");
        return { stdout: `${JSON.stringify(args[1] === "connect" ? treeReply(treePath) : installReply)}\n` };
      },
      platform: "linux",
    });
    const cwd = resolve(home, "workspace");

    await expect(manager.ensureAgent(cwd)).resolves.toMatchObject({ status: "unavailable" });
    // A failure is never cached, so a transient fault recovers without restarting the daemon.
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "ready", treePath });
  });

  it("degrades on a platform with no shim, and on unreadable configuration", async () => {
    const windowsHome = await temporaryHome("opentag-context-tree-win32-");
    await writeConfig(windowsHome, { kind: "managed", name: "team-context-tree" });
    const windows = new ContextTreeManager({
      home: windowsHome,
      contextTreePackage: fixturePackage(resolve(windowsHome, "pkg")),
      platform: "win32",
    });
    await expect(windows.ensureAgent(resolve(windowsHome, "workspace"))).resolves.toEqual({
      status: "unavailable",
      reason: "SHIM_UNAVAILABLE",
    });

    const corruptHome = await temporaryHome("opentag-context-tree-corrupt-");
    const layout = resolveOpenTagHomeLayout(corruptHome);
    await mkdir(layout.config, { mode: 0o700, recursive: true });
    await writeFile(layout.contextTreeConfigFile, "{ not json", "utf8");
    const corrupt = new ContextTreeManager({ home: corruptHome, contextTreePackage: null });
    await expect(corrupt.readConfig()).resolves.toBeUndefined();
    await expect(corrupt.ensureAgent(resolve(corruptHome, "workspace"))).resolves.toEqual({ status: "unconfigured" });
  });

  it("serializes concurrent workspace preparation, because the connection store has no lock", async () => {
    const home = await temporaryHome("opentag-context-tree-serial-");
    await writeConfig(home, { kind: "managed", name: "team-context-tree" });
    let active = 0;
    let overlapped = false;
    const manager = new ContextTreeManager({
      home,
      contextTreePackage: fixturePackage(resolve(home, "pkg")),
      execFile: async (_file, args) => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((done) => setTimeout(done, 1));
        active -= 1;
        return { stdout: `${JSON.stringify(args[1] === "connect" ? treeReply(resolve(home, "t")) : installReply)}\n` };
      },
      platform: "linux",
    });

    const results = await Promise.all(
      ["a", "b", "c"].map((name) => manager.ensureAgent(resolve(home, "workspaces", name))),
    );

    expect(overlapped).toBe(false);
    // Sharing one tree across Agents is the point of the feature.
    expect(new Set(results.map((status) => (status.status === "ready" ? status.treePath : "")))).toHaveProperty(
      "size",
      1,
    );
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
  it("resolves the installed package and its assets exist on disk", async () => {
    const resolved = resolveContextTreePackage();
    expect(resolved).toBeDefined();
    if (!resolved) return;
    await expect(stat(resolved.cliPath)).resolves.toMatchObject({});
    await expect(stat(join(resolved.skillsPath, "context-tree-read", "SKILL.md"))).resolves.toMatchObject({});
  });
});
