import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextTreeConnection, contextTreeSelector } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextTreeManager, codexInstallSkipReason, contextTreeFailureCode } from "../runtime/context-tree.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const sources = [
  { kind: "git", repository: "acme/project", path: "docs", ref: "main" },
  { kind: "git", repository: "acme/project", path: "notes", ref: "main" },
] as const satisfies readonly ContextTreeConnection[];
async function fixture(options: { sync?: () => Promise<void>; denied?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ct-manager-"));
  roots.push(home);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[1] !== "sync") return { stdout: JSON.stringify({ installed: [{ host: "codex" }] }) };
    const projectRoot = args[args.indexOf("--project-path") + 1] ?? "";
    const config = JSON.parse(await readFile(join(projectRoot, ".context-tree.json"), "utf8"));
    const source = config.trees.find(
      (entry: ContextTreeConnection) => contextTreeSelector(entry) === args[args.indexOf("--tree") + 1],
    );
    if (!source) throw new Error("Selection was not persisted before fetching");
    await options.sync?.();
    return {
      stdout: JSON.stringify({
        schemaVersion: 3,
        connections: [
          {
            ok: true,
            connection: { projectRoot, source },
            treeRoot: join(home, ".context-tree", source.path),
            repository: {
              root: join(home, ".context-tree"),
              directory: source.path,
              sha: "a".repeat(40),
              branch: source.ref,
            },
            dirty: false,
          },
        ],
      }),
    };
  });
  const manager = new ContextTreeManager({
    home,
    environment: { HOME: home },
    managedCredentials: options.denied,
    contextTreePackage: { root: home, cliPath: join(home, "cli.mjs"), skillsPath: home },
    execFile,
    sessionStartBudgetMs: options.sync ? 10 : 1000,
  });
  return { home, cwd, manager, execFile };
}
it("syncs distinct subtrees once, reuses results, and preserves repository-owned config", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, ".context-tree.json"), "user owned config");
  const status = await f.manager.ensureAgent(f.cwd, "pi", sources);
  expect(status).toMatchObject({ connections: sources.map((source) => ({ ...source, status: "ready" })) });
  await f.manager.ensureAgent(f.cwd, "pi", [...sources].reverse());
  expect(f.execFile).toHaveBeenCalledTimes(2);
  expect(await readFile(join(f.cwd, ".context-tree.json"), "utf8")).toBe("user owned config");
  await f.manager.ensureAgent(f.cwd, "pi", [sources[0]]);
  const config = JSON.parse(await readFile(join(f.cwd, ".opentag/context-tree/project/.context-tree.json"), "utf8"));
  expect(config.trees).toEqual([sources[0]]);
});
it("bounds startup while retaining and joining background work", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ sync: () => blocked });
  expect(await f.manager.ensureAgent(f.cwd, "pi", [sources[0]])).toMatchObject({
    connections: [{ reason: "PREPARING" }],
  });
  release();
  await vi.waitFor(async () => {
    expect(await f.manager.ensureAgent(f.cwd, "pi", [sources[0]])).toMatchObject({
      connections: [{ status: "ready" }],
    });
  });
  expect(f.execFile).toHaveBeenCalledTimes(1);
});
it("keeps a ready snapshot when the managed execution token rotates", async () => {
  const f = await fixture({ denied: true });
  const environment = { GH_TOKEN: "first-execution", OPENTAG_PROVIDER_PROXY_URL: "http://localhost/proxy" };
  const first = await f.manager.ensureAgent(f.cwd, "pi", sources, environment);
  expect(first).toMatchObject({ connections: [{ status: "ready" }, { status: "ready" }] });
  expect(await f.manager.ensureAgent(f.cwd, "pi", sources, { ...environment, GH_TOKEN: "next-execution" })).toEqual(
    first,
  );
  expect(f.execFile.mock.calls.filter(([, args]) => args[1] === "sync")).toHaveLength(2);
});
it("does not expose cached selections after authorization is removed", async () => {
  const f = await fixture({ denied: true });
  const auth = { GH_TOKEN: "execution", OPENTAG_PROVIDER_PROXY_URL: "http://localhost/proxy" };
  await f.manager.ensureAgent(f.cwd, "pi", sources, auth);
  expect(await f.manager.ensureAgent(f.cwd, "pi", sources, {})).toMatchObject({
    connections: [{ reason: "GITHUB_PERMISSION" }, { reason: "GITHUB_PERMISSION" }],
  });
  const config = JSON.parse(await readFile(join(f.cwd, ".opentag/context-tree/project/.context-tree.json"), "utf8"));
  expect(config.trees).toEqual([]);
});
describe("contextTreeFailureCode", () => {
  it.each([
    [{ ok: true, findings: [] }, undefined],
    [{ error: { code: "NO_CONNECTION", message: "" }, ok: false }, "NO_CONNECTION"],
    [{ findings: [{ code: "TREE_FRONTMATTER_MISSING" }], ok: false }, "TREE_FRONTMATTER_MISSING"],
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
  ])("reads %j as %s", (payload, expected) => {
    expect(codexInstallSkipReason(payload)).toBe(expected);
  });
});
