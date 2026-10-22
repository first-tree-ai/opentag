import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCloudContextTree } from "../runner/cloud-context-tree.js";
import type { ContextTreeExecFile } from "../runtime/context-tree.js";
import { managedAgentSlug } from "../runtime/managed-instructions.js";

const roots: string[] = [];
const GRANT = { GH_TOKEN: "execution", OPENTAG_PROVIDER_PROXY_URL: "http://localhost/proxy" };
const source = { kind: "git", repository: "acme/project", path: "docs", ref: "main" } as const;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function temporaryDirectory(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}
async function fixture() {
  const workspace = await temporaryDirectory("ct-cloud-");
  const projectRoot = join(workspace, ".opentag/context-tree/project");
  const treeRoot = join(workspace, ".opentag/context-tree/home/.context-tree/snapshots/commit/docs");
  await mkdir(treeRoot, { recursive: true });
  const input = {
    workspace,
    contextTrees: [source],
    environment: GRANT,
    path: process.env.PATH ?? "",
    scratch: join(workspace, "scratch"),
  };
  const entry = {
    ok: true,
    connection: { projectRoot, source },
    treeRoot,
    repository: { root: treeRoot, directory: "docs", sha: "a".repeat(40), branch: "main" },
    dirty: false,
  };
  const payload = { schemaVersion: 3, connections: [entry] };
  const pack = { root: workspace, cliPath: join(workspace, "cli.mjs"), skillsPath: workspace };
  return { workspace, projectRoot, treeRoot, input, payload, pack };
}
it("saves selection before one sync and leaves repository configuration alone", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, ".context-tree.json"), "repository owned");
  const execFile = vi.fn<ContextTreeExecFile>(async (_file, args, options) => {
    expect(args[1]).toBe("sync");
    expect(args).not.toContain("--offline");
    expect(JSON.parse(await readFile(join(f.projectRoot, ".context-tree.json"), "utf8")).trees).toEqual([source]);
    expect(options.env?.HOME).toBe(join(f.workspace, ".opentag/context-tree/home"));
    return { stdout: JSON.stringify(f.payload) };
  });
  const result = await prepareCloudContextTree(f.input, { contextTreePackage: f.pack, execFile });
  expect(result.status).toMatchObject({
    connections: [{ status: "ready", treePath: f.treeRoot, projectPath: f.projectRoot }],
  });
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.workspace, ".context-tree.json"), "utf8")).toBe("repository owned");
  if (!result.binDirectory) throw new Error("Missing shim");
  expect(await readFile(join(result.binDirectory, "context-tree"), "utf8")).not.toContain(GRANT.GH_TOKEN);
});
it("recovers offline with a fresh budget after refresh times out, and succeeds next turn", async () => {
  const f = await fixture();
  let timeout = true;
  const execFile = vi.fn<ContextTreeExecFile>(async (_file, args, options) => {
    if (timeout && !args.includes("--offline")) {
      await new Promise<void>((done) => options.signal?.addEventListener("abort", () => done(), { once: true }));
      throw Object.assign(new Error("cancelled"), { killed: true, signal: "SIGTERM", stdout: "" });
    }
    expect(options.signal?.aborted).toBe(false);
    return { stdout: JSON.stringify(f.payload) };
  });
  const internals = { contextTreePackage: f.pack, execFile, preparationBudgetMs: 10 };
  expect((await prepareCloudContextTree(f.input, internals)).status).toMatchObject({
    connections: [{ status: "stale", reason: "TIMEOUT" }],
  });
  timeout = false;
  expect((await prepareCloudContextTree(f.input, internals)).status).toMatchObject({
    connections: [{ status: "ready" }],
  });
  expect(execFile.mock.calls.map((call) => call[1].slice(1)[0])).toEqual(["sync", "sync", "sync"]);
});
it("preserves healthy entries from a nonzero sync result", async () => {
  const f = await fixture();
  const other = { ...source, path: "notes" };
  const execFile: ContextTreeExecFile = async () => {
    throw Object.assign(new Error("partial"), {
      stdout: JSON.stringify({
        ...f.payload,
        connections: [
          ...f.payload.connections,
          {
            ok: false,
            connection: { projectRoot: f.projectRoot, source: other },
            error: { code: "CONTEXT_TREE_FAILED", message: "missing" },
          },
        ],
      }),
    });
  };
  expect(
    (
      await prepareCloudContextTree(
        { ...f.input, contextTrees: [source, other] },
        { contextTreePackage: f.pack, execFile },
      )
    ).status,
  ).toMatchObject({ connections: [{ status: "ready" }, { status: "unavailable" }] });
});
it.each(["INVALID_TREE", "DIRTY_TREE"])("does not recover a rejected snapshot offline: %s", async (code) => {
  const f = await fixture();
  const execFile: ContextTreeExecFile = async (_file, args) => ({
    stdout: JSON.stringify(
      args.includes("--offline")
        ? f.payload
        : {
            schemaVersion: 3,
            connections: [
              { ok: false, connection: { projectRoot: f.projectRoot, source }, error: { code, message: "rejected" } },
            ],
          },
    ),
  });
  const result = await prepareCloudContextTree(f.input, { contextTreePackage: f.pack, execFile });
  expect(result.status).toMatchObject({ connections: [{ status: "unavailable", reason: code }] });
  expect(result.binDirectory).toBeUndefined();
});
it("never exposes another project's or branch's snapshot", async () => {
  const f = await fixture();
  for (const connection of [
    { projectRoot: f.workspace, source },
    { projectRoot: f.projectRoot, source: { ...source, ref: "other" } },
  ]) {
    const execFile: ContextTreeExecFile = async () => ({
      stdout: JSON.stringify({ ...f.payload, connections: [{ ...f.payload.connections[0], connection }] }),
    });
    const result = await prepareCloudContextTree(f.input, { contextTreePackage: f.pack, execFile });
    expect(result.status).toMatchObject({ connections: [{ status: "unavailable" }] });
    expect(result.binDirectory).toBeUndefined();
  }
});
it("revokes selection without deleting cached files or exposing a CLI", async () => {
  const f = await fixture();
  const execFile = vi.fn<ContextTreeExecFile>();
  const result = await prepareCloudContextTree(
    { ...f.input, environment: {} },
    { contextTreePackage: f.pack, execFile },
  );
  expect(result.status).toMatchObject({ connections: [{ reason: "GITHUB_PERMISSION" }] });
  expect(result.binDirectory).toBeUndefined();
  expect(execFile).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(f.projectRoot, ".context-tree.json"), "utf8")).trees).toEqual([]);
  await expect(access(f.treeRoot)).resolves.toBeUndefined();
});
describe("prepareCloudContextTree process ownership", () => {
  it("stops the whole owned process tree and leaves no write after the preparation is aborted", async () => {
    const root = await temporaryDirectory("opentag-cloud-ct-abort-");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const scratch = join(root, "scratch");
    await mkdir(scratch, { recursive: true });
    const script = join(root, "fake-cli.mjs");
    const pidsFile = join(root, "pids.json");
    const markerFile = join(workspace, "late-write.txt");
    // The fake CLI emulates the packaged CLI: it stays alive while a detached child (like the
    // CLI's own `git`) mutates the workspace after a delay. Only killing the CLI's process group
    // would leave that child running and writing.
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const nested = spawn(process.execPath, ["-e", `const { writeFileSync } = require("node:fs"); setTimeout(() => writeFileSync(process.env.OPENTAG_TEST_MARKER, "late"), 3000); setInterval(() => {}, 1000);`], { detached: true, env: process.env, stdio: "ignore" });',
        "nested.unref();",
        "writeFileSync(process.env.OPENTAG_TEST_PIDS, JSON.stringify([process.pid, nested.pid]));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const controller = new AbortController();
    const preparation = prepareCloudContextTree(
      {
        agentSlug: "tree-agent",
        environment: { ...GRANT, OPENTAG_TEST_MARKER: markerFile, OPENTAG_TEST_PIDS: pidsFile },
        path: process.env.PATH ?? "",
        contextTrees: [{ kind: "git" as const, path: ".", ref: "main", repository: "acme/memory" }],
        scratch,
        signal: controller.signal,
        workspace,
      },
      { contextTreePackage: { root, cliPath: script, skillsPath: root } },
    );
    let pids: number[] = [];
    for (let attempt = 0; attempt < 200 && pids.length === 0; attempt += 1) {
      try {
        pids = JSON.parse(await readFile(pidsFile, "utf8")) as number[];
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const [cliPid, nestedPid] = pids;
    if (cliPid === undefined || nestedPid === undefined) throw new Error("the fake CLI did not record its pids");
    expect(processAlive(cliPid)).toBe(true);

    controller.abort();
    await expect(preparation).resolves.toMatchObject({
      status: { connections: [{ status: "unavailable", reason: "TIMEOUT" }] },
    });
    for (let attempt = 0; attempt < 100 && (processAlive(cliPid) || processAlive(nestedPid)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The detached nested process is gone too: the failed preparation owns no writer.
    expect(processAlive(cliPid)).toBe(false);
    expect(processAlive(nestedPid)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(access(markerFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("managedAgentSlug", () => {
  it.each([
    ["You run inside OpenTag.\n\nOpenTag Agent slug: tree-agent", "tree-agent"],
    ["OpenTag Agent slug: a1\nTrailing line.", "a1"],
    ["OpenTag Agent slug: Tree-Agent", undefined],
    ["OpenTag Agent slug: not a slug!", undefined],
    ["no slug here", undefined],
    ["", undefined],
  ])("extracts from %j", (platform, expected) => {
    expect(managedAgentSlug(platform)).toBe(expected);
  });
});
