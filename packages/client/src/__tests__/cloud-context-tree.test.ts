import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOUD_CONTEXT_TREE_SUBDIRECTORY,
  type CloudContextTreePreparationInput,
  cloudAgentSlug,
  prepareCloudContextTree,
} from "../runner/cloud-context-tree.js";
import type { ContextTreeExecFile } from "../runtime/context-tree.js";

const directories: string[] = [];
afterEach(async () =>
  Promise.all(
    directories.splice(0).map(async (path) => {
      // Some fixtures revoke write permission on the way in; restore it so removal works.
      await chmod(path, 0o700).catch(() => undefined);
      await rm(path, { force: true, recursive: true });
    }),
  ),
);

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

const PACKAGE = { root: "/pkg", cliPath: "/pkg/dist/cli/index.mjs", skillsPath: "/pkg/skills" };
const GRANT = { OPENTAG_GITHUB_REPOSITORIES: JSON.stringify([{ fullName: "acme/memory", role: "context_tree" }]) };

interface CapturedCall {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  network: boolean;
}

/**
 * A scripted Context Tree CLI. `payloads` maps the command name to its JSON payload (or an
 * `error.code` envelope); network flags are derived from the command the way the production code
 * passes them, so the assertions observe the exact behavior the real CLI wrapper would see.
 */
async function fixture(options: {
  payloads?: Record<string, unknown>;
  kill?: Record<string, boolean>;
  repository?: string | null;
  environment?: Record<string, string>;
  priorTreeHome?: boolean;
  treePathInsideWorkspace?: boolean;
  agentSlug?: string;
  preserved?: {
    repository?: string;
    kind?: string;
    treePath?: string;
    projectPath?: string;
    outsideWorkspace?: boolean;
    raw?: string;
  };
}) {
  const root = await temporaryDirectory("opentag-cloud-ct-unit-");
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspace = await realpath(workspacePath);
  const scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  const treePath = join(
    workspace,
    ...(options.treePathInsideWorkspace === false
      ? []
      : [CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home", ".context-tree", "trees", "github-abc"]),
  );
  const calls: CapturedCall[] = [];
  const execFile: ContextTreeExecFile = async (_file, args, execOptions) => {
    const command = args[1] as string;
    calls.push({
      args: args.slice(1) as string[],
      cwd: execOptions.cwd,
      env: execOptions.env,
      network: execOptions.timeout > 30_000,
    });
    if (options.kill?.[command]) throw Object.assign(new Error("killed"), { killed: true });
    const payload =
      options.payloads?.[command] ??
      (command === "connect"
        ? { tree: { path: treePath } }
        : command === "sync"
          ? { branch: "master", sha: "a".repeat(40) }
          : command === "disconnect"
            ? { disconnected: true, schemaVersion: 1 }
            : {});
    return { stdout: JSON.stringify(payload) };
  };
  if (options.priorTreeHome) {
    await mkdir(join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home"), { recursive: true });
  }
  if (options.preserved) {
    const home = join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home");
    const preservedTreePath =
      options.preserved.treePath ?? (options.preserved.outsideWorkspace ? join(root, "outside-tree") : treePath);
    await mkdir(preservedTreePath, { recursive: true });
    await mkdir(join(home, ".context-tree"), { recursive: true });
    await writeFile(
      join(home, ".context-tree", "connections.json"),
      options.preserved.raw ??
        `${JSON.stringify({
          connections: [
            {
              projectPath: options.preserved.projectPath ?? workspace,
              tree: {
                kind: options.preserved.kind ?? "github",
                path: preservedTreePath,
                repository: options.preserved.repository ?? "acme/memory",
              },
            },
          ],
          schemaVersion: 1,
        })}\n`,
    );
  }
  const input: CloudContextTreePreparationInput = {
    workspace,
    repository: options.repository === undefined ? "acme/memory" : options.repository,
    environment: options.environment ?? GRANT,
    path: "/exec/bin:/usr/bin:/bin",
    scratch,
    ...(options.agentSlug ? { agentSlug: options.agentSlug } : {}),
  };
  return {
    calls,
    execFile,
    input,
    root,
    scratch,
    treeHome: join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home"),
    treePath,
    workspace,
  };
}

async function shim(root: string): Promise<string> {
  return readFile(join(root, "scratch", "context-tree-bin", "context-tree"), "utf8");
}

describe("prepareCloudContextTree (unit)", () => {
  it("leaves an unconfigured Session untouched without any CLI call", async () => {
    const { calls, execFile, input, workspace } = await fixture({ repository: null });
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result).toEqual({ status: { status: "unconfigured" } });
    expect(calls).toEqual([]);
    // No tree subtree is created for a Session that never selected one.
    await expect(stat(join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the preserved record and drafts when the current Turn unselects the tree", async () => {
    const { calls, execFile, input, treeHome, treePath } = await fixture({ repository: null, preserved: {} });
    await writeFile(join(treePath, "draft.md"), "unpublished draft");
    const recordBefore = await readFile(join(treeHome, ".context-tree", "connections.json"), "utf8");
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result).toEqual({ status: { status: "unconfigured" } });
    // Unselecting reports the state without a CLI call, without deleting the record or drafts.
    expect(calls).toEqual([]);
    expect(await readFile(join(treeHome, ".context-tree", "connections.json"), "utf8")).toBe(recordBefore);
    expect(await readFile(join(treePath, "draft.md"), "utf8")).toBe("unpublished draft");
  });

  it("reports PACKAGE_MISSING without running anything when the packaged CLI is absent", async () => {
    const { calls, execFile, input } = await fixture({});
    await expect(prepareCloudContextTree(input, { contextTreePackage: null, execFile })).resolves.toEqual({
      status: { status: "unavailable", reason: "PACKAGE_MISSING" },
    });
    expect(calls).toEqual([]);
  });

  it("reports WORKSPACE_MISSING when the Session workspace is not there", async () => {
    const { calls, execFile, input, root } = await fixture({});
    await expect(
      prepareCloudContextTree(
        { ...input, workspace: join(root, "missing-workspace") },
        { contextTreePackage: PACKAGE, execFile },
      ),
    ).resolves.toEqual({ status: { status: "unavailable", reason: "WORKSPACE_MISSING" } });
    expect(calls).toEqual([]);
  });

  it.each([
    ["absent", {}],
    [
      "for another repository",
      { OPENTAG_GITHUB_REPOSITORIES: JSON.stringify([{ fullName: "acme/other", role: "context_tree" }]) },
    ],
    [
      "with only a code role",
      { OPENTAG_GITHUB_REPOSITORIES: JSON.stringify([{ fullName: "acme/memory", role: "code" }]) },
    ],
    ["malformed", { OPENTAG_GITHUB_REPOSITORIES: "not-json" }],
  ])(
    "denies the connect when the current grant is %s, preserving the record and drafts",
    async (_label, environment) => {
      const { calls, execFile, input, treeHome, treePath } = await fixture({ environment, preserved: {} });
      await writeFile(join(treePath, "draft.md"), "unpublished draft");
      const recordBefore = await readFile(join(treeHome, ".context-tree", "connections.json"), "utf8");
      const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
      expect(result).toEqual({ status: { status: "unavailable", reason: "GITHUB_PERMISSION" } });
      // A revoked grant never runs the CLI, never touches the record's checkout, and never erases.
      expect(calls).toEqual([]);
      expect(await readFile(join(treeHome, ".context-tree", "connections.json"), "utf8")).toBe(recordBefore);
      expect(await readFile(join(treePath, "draft.md"), "utf8")).toBe("unpublished draft");
    },
  );

  it("connects and synchronizes with the per-execution environment and an in-workspace HOME", async () => {
    const { calls, execFile, input, treePath, workspace } = await fixture({
      environment: { ...GRANT, GH_TOKEN: "execution-handle", GIT_CONFIG_GLOBAL: "/exec/gitconfig" },
    });
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result.status).toEqual({ status: "ready", treePath, branch: "master", sha: "a".repeat(40) });
    expect(calls.map((call) => call.args)).toEqual([
      ["connect", "acme/memory", "--project-path", resolve(workspace), "--json"],
      ["sync", "--project-path", resolve(workspace)],
    ]);
    for (const call of calls) {
      expect(call.network).toBe(true);
      expect(call.cwd).toBe(resolve(workspace));
      expect(call.env?.HOME).toBe(join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home"));
      expect(call.env?.TMPDIR).toBe(join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "tmp"));
      expect(call.env?.PATH).toBe("/exec/bin:/usr/bin:/bin");
      // The per-execution proxy manifest is the only credential source.
      expect(call.env?.GH_TOKEN).toBe("execution-handle");
      expect(call.env?.GIT_CONFIG_GLOBAL).toBe("/exec/gitconfig");
    }
    // The pinned arrangement cannot be redirected by manifest content.
    expect(calls[0]?.env?.HOME).not.toBe(process.env.HOME);
  });

  it("manifest variables cannot override the pinned HOME/TMPDIR/PATH arrangement", async () => {
    const { calls, execFile, input, workspace } = await fixture({
      environment: { ...GRANT, HOME: "/attacker/home", TMPDIR: "/attacker/tmp", PATH: "/attacker/bin" },
    });
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result.status.status).toBe("ready");
    expect(calls[0]?.env?.HOME).toBe(join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home"));
    expect(calls[0]?.env?.TMPDIR).toBe(join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "tmp"));
    expect(calls[0]?.env?.PATH).toBe("/exec/bin:/usr/bin:/bin");
  });

  it.each(["GITHUB_AUTH", "TIMEOUT"])(
    "surfaces the connect failure code %s without a preserved checkout",
    async (code) => {
      const { calls, execFile, input, scratch } = await fixture({
        payloads: { connect: { error: { code }, ok: false } },
      });
      const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
      expect(result).toEqual({ status: { status: "unavailable", reason: code } });
      expect(calls.map((call) => call.args[0])).toEqual(["connect"]);
      await expect(stat(join(scratch, "context-tree-bin"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("addresses a dirty preserved checkout as stale and gives the Agent the pinned CLI", async () => {
    const { calls, execFile, input, scratch, treePath } = await fixture({
      payloads: { connect: { error: { code: "DIRTY_TREE" }, ok: false } },
      preserved: {},
    });
    await writeFile(join(treePath, "draft.md"), "unpublished draft");
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    // The drafts survive and the tree stays addressable; it is never presented as current.
    expect(result.status).toEqual({ status: "stale", treePath, reason: "DIRTY_TREE" });
    expect(result.binDirectory).toBe(join(scratch, "context-tree-bin"));
    expect(calls.map((call) => call.args[0])).toEqual(["connect"]);
    expect(await readFile(join(treePath, "draft.md"), "utf8")).toBe("unpublished draft");
    await expect(stat(join(scratch, "context-tree-bin", "context-tree"))).resolves.toMatchObject({});
  });

  it("refuses to address a preserved record for another repository", async () => {
    const { execFile, input, scratch, treePath } = await fixture({
      payloads: { connect: { error: { code: "CONTEXT_TREE_FAILED" }, ok: false } },
      preserved: { repository: "other/memory" },
    });
    await writeFile(join(treePath, "draft.md"), "draft of the previous selection");
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result).toEqual({ status: { status: "unavailable", reason: "CONTEXT_TREE_FAILED" } });
    await expect(stat(join(scratch, "context-tree-bin"))).rejects.toMatchObject({ code: "ENOENT" });
    // A rebind never erases the previous selection's unpublished work.
    expect(await readFile(join(treePath, "draft.md"), "utf8")).toBe("draft of the previous selection");
  });

  it("refuses to address a preserved record whose checkout left the workspace", async () => {
    const { execFile, input, scratch } = await fixture({
      payloads: { connect: { error: { code: "CONTEXT_TREE_FAILED" }, ok: false } },
      preserved: { outsideWorkspace: true },
    });
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result).toEqual({ status: { status: "unavailable", reason: "CONTEXT_TREE_FAILED" } });
    await expect(stat(join(scratch, "context-tree-bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a local-kind or corrupt preserved record", async () => {
    const local = await fixture({
      payloads: { connect: { error: { code: "CONTEXT_TREE_FAILED" }, ok: false } },
      preserved: { kind: "local", repository: "acme/memory" },
    });
    await expect(
      prepareCloudContextTree(local.input, { contextTreePackage: PACKAGE, execFile: local.execFile }),
    ).resolves.toEqual({ status: { status: "unavailable", reason: "CONTEXT_TREE_FAILED" } });

    const corrupt = await fixture({
      payloads: { connect: { error: { code: "CONTEXT_TREE_FAILED" }, ok: false } },
      preserved: { raw: "{not json" },
    });
    await expect(
      prepareCloudContextTree(corrupt.input, { contextTreePackage: PACKAGE, execFile: corrupt.execFile }),
    ).resolves.toEqual({ status: { status: "unavailable", reason: "CONTEXT_TREE_FAILED" } });
  });

  it("maps a killed connect to TIMEOUT", async () => {
    const { execFile, input } = await fixture({ kill: { connect: true } });
    await expect(prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile })).resolves.toEqual({
      status: { status: "unavailable", reason: "TIMEOUT" },
    });
  });

  it("reports CONNECT_FAILED when the connect payload carries no tree path", async () => {
    const { execFile, input } = await fixture({ payloads: { connect: { schemaVersion: 1 } } });
    await expect(prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile })).resolves.toEqual({
      status: { status: "unavailable", reason: "CONNECT_FAILED" },
    });
  });

  it("refuses a connected checkout outside the saved workspace", async () => {
    const { execFile, input } = await fixture({ payloads: { connect: { tree: { path: "/outside/tree" } } } });
    await expect(prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile })).resolves.toEqual({
      status: { status: "unavailable", reason: "TREE_OUTSIDE_WORKSPACE" },
    });
  });

  it.each(["CONTEXT_TREE_FAILED", "TIMEOUT"])("reports a failed sync as stale (%s), keeping the shim", async (code) => {
    const { execFile, input, scratch, treePath } = await fixture(
      code === "TIMEOUT" ? { kill: { sync: true } } : { payloads: { sync: { error: { code }, ok: false } } },
    );
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result.status).toEqual({ status: "stale", treePath, reason: code });
    // The tree is still active for the Turn: the agent-facing shim exists for reads/retries.
    expect(result.binDirectory).toBe(join(scratch, "context-tree-bin"));
    await expect(stat(join(scratch, "context-tree-bin", "context-tree"))).resolves.toMatchObject({});
  });

  it("writes the agent-facing shim pinned to the in-workspace HOME/TMPDIR, the packaged CLI and the Agent identity", async () => {
    const { execFile, input, root, treePath, workspace } = await fixture({ agentSlug: "tree-agent" });
    const result = await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(result.status).toEqual({ status: "ready", treePath, branch: "master", sha: "a".repeat(40) });
    const content = await shim(root);
    expect(content).toContain(`HOME='${join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home")}'`);
    expect(content).toContain(`TMPDIR='${join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "tmp")}'`);
    expect(content).toContain("GIT_AUTHOR_NAME='tree-agent'");
    expect(content).toContain("GIT_COMMITTER_EMAIL='tree-agent@localhost'");
    expect(content).toContain(`exec '${process.execPath}' '${PACKAGE.cliPath}' "$@"`);
    expect(content).not.toContain("GH_TOKEN");
    expect((await stat(join(root, "scratch", "context-tree-bin", "context-tree"))).mode & 0o777).toBe(0o700);
    // The shim directory is scratch, never the saved workspace.
    expect(result.binDirectory?.startsWith(join(workspace, sep))).toBe(false);
  });

  it("falls back to a generic commit identity when the platform instructions carry no slug", async () => {
    const { execFile, input, root } = await fixture({});
    await prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile });
    expect(await shim(root)).toContain("GIT_AUTHOR_NAME='opentag-cloud-agent'");
  });

  it("never throws into the Turn when the workspace is not writable", async () => {
    const { execFile, input, workspace } = await fixture({});
    await chmod(workspace, 0o555);
    try {
      await expect(prepareCloudContextTree(input, { contextTreePackage: PACKAGE, execFile })).resolves.toEqual({
        status: { status: "unavailable", reason: "PREPARATION_FAILED" },
      });
    } finally {
      await chmod(workspace, 0o700);
    }
  });
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
        repository: "acme/memory",
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
    await expect(preparation).resolves.toEqual({ status: { status: "unavailable", reason: "TIMEOUT" } });
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

describe("cloudAgentSlug", () => {
  it.each([
    ["You run inside OpenTag.\n\nOpenTag Agent slug: tree-agent", "tree-agent"],
    ["OpenTag Agent slug: a1\nTrailing line.", "a1"],
    ["OpenTag Agent slug: Tree-Agent", undefined],
    ["OpenTag Agent slug: not a slug!", undefined],
    ["no slug here", undefined],
    ["", undefined],
  ])("extracts from %j", (platform, expected) => {
    expect(cloudAgentSlug(platform)).toBe(expected);
  });
});
