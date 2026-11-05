import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextTreeConnection, EffectiveRuntimeSnapshot } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextTreeManager, codexInstallSkipReason, contextTreeFailureCode } from "../runtime/context-tree.js";
import { renderManagedSystemPrompt } from "../runtime/managed-instructions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const sources = [
  { kind: "git", repository: "acme/project", path: "docs", ref: "main" },
  { kind: "git", repository: "acme/project", path: "notes", ref: "main" },
] as const satisfies readonly ContextTreeConnection[];
const authorized = { GH_TOKEN: "first-execution", OPENTAG_PROVIDER_PROXY_URL: "http://localhost/proxy" };
async function fixture(
  options: { managed?: boolean; codex?: unknown; platform?: NodeJS.Platform; noPackage?: boolean } = {},
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ct-manager-")));
  roots.push(home);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[1] === "sync") throw new Error("Preparation must not sync");
    return { stdout: JSON.stringify(options.codex ?? { installed: [{ host: "codex" }] }) };
  });
  const manager = new ContextTreeManager({
    home,
    environment: { HOME: home },
    managedCredentials: options.managed,
    contextTreePackage: options.noPackage ? null : { root: home, cliPath: join(home, "cli.mjs"), skillsPath: home },
    execFile,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const projectPath = join(cwd, ".opentag", "context-tree", "project");
  return { home, cwd, manager, execFile, projectPath };
}
const cliCommands = (execFile: ReturnType<typeof vi.fn>) =>
  execFile.mock.calls.map(([, args]) => (args as readonly string[]).slice(1, 3).join(" "));
const ranSync = (execFile: ReturnType<typeof vi.fn>) =>
  execFile.mock.calls.some(([, args]) => (args as readonly string[]).includes("sync"));

it("prepares without syncing and preserves repository-owned config", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, ".context-tree.json"), "user owned config");
  const status = await f.manager.ensureAgent(f.cwd, "codex", sources);
  expect(status).toEqual({
    status: "configured",
    connections: sources.map((source) => ({ ...source, status: "available", projectPath: f.projectPath })),
  });
  expect(cliCommands(f.execFile)).toEqual(["skills install", "skills install"]);
  await f.manager.ensureAgent(f.cwd, "codex", [...sources].reverse());
  expect(ranSync(f.execFile)).toBe(false);
  expect(f.execFile).toHaveBeenCalledTimes(2);
  expect(await readFile(join(f.cwd, ".context-tree.json"), "utf8")).toBe("user owned config");
  await f.manager.ensureAgent(f.cwd, "pi", [sources[0]]);
  const config = JSON.parse(await readFile(join(f.projectPath, ".context-tree.json"), "utf8"));
  expect(config.trees).toEqual([sources[0]]);
  expect(await readFile(join(f.manager.binDirectory(), "context-tree"), "utf8")).toContain("context-tree-client.mjs");
});

it("renders an identical managed prompt across preparations and execution token rotation", async () => {
  const f = await fixture({ managed: true });
  const snapshot: EffectiveRuntimeSnapshot = {
    contextTrees: [...sources],
    revision: { agent: { sequence: 1, id: "agent-1" }, session: { sequence: 1, id: "session-1" } },
    agentId: "agent-1",
    provider: "codex",
    model: "model-1",
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never", networkAccess: true },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    selfConfigurationEnabled: true,
  };
  const render = async (environment: Record<string, string>) =>
    renderManagedSystemPrompt(snapshot, {
      environment: "local",
      sessionId: "session-1",
      sessionKind: "visible",
      cliCommand: "opentag",
      sessionCliAvailable: true,
      selfConfigurationEnabled: true,
      contextTree: await f.manager.ensureAgent(f.cwd, "pi", sources, environment),
    });
  const first = await render(authorized);
  const second = await render({ ...authorized, GH_TOKEN: "next-execution" });
  expect(second).toBe(first);
  expect(first).toContain(`context-tree sync --project-path ${JSON.stringify(f.projectPath)}`);
  expect(first).not.toMatch(/\/snapshots\/|synchronized|commit [0-9a-f]{7,}/);
  expect(f.execFile).not.toHaveBeenCalled();
});

it("reports managed authorization failures and clears the persisted selection", async () => {
  const f = await fixture({ managed: true });
  await f.manager.ensureAgent(f.cwd, "pi", sources, authorized);
  expect(await f.manager.ensureAgent(f.cwd, "pi", sources, {})).toMatchObject({
    connections: [{ reason: "GITHUB_PERMISSION" }, { reason: "GITHUB_PERMISSION" }],
  });
  const config = JSON.parse(await readFile(join(f.projectPath, ".context-tree.json"), "utf8"));
  expect(config.trees).toEqual([]);
  expect(await f.manager.ensureAgent(f.cwd, "pi", sources)).toMatchObject({
    connections: [
      { status: "unavailable", reason: "AUTHENTICATION_REQUIRED" },
      { status: "unavailable", reason: "AUTHENTICATION_REQUIRED" },
    ],
  });
});

it.each([
  ["PACKAGE_MISSING", { noPackage: true }],
  ["SHIM_UNAVAILABLE", { platform: "win32" as const }],
  ["CODEX_NOT_INSTALLED", { codex: { installed: [], skipped: [] } }],
])("reports %s as unavailable", async (reason, options) => {
  const f = await fixture(options);
  expect(await f.manager.ensureAgent(f.cwd, "codex", sources)).toEqual({
    status: "configured",
    connections: sources.map((source) => ({ ...source, status: "unavailable", reason })),
  });
  expect(ranSync(f.execFile)).toBe(false);
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
