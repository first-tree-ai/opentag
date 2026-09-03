import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextTreeManager, resolveContextTreePackage } from "../runtime/context-tree.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

/** End-to-end against the real packaged CLI and a real Git tree, offline and under a redirected HOME. */

const execFileAsync = promisify(execFile);
const contextTreePackage = resolveContextTreePackage();
const directories: string[] = [];
let previousHome: string | undefined;
let homeWasSet = false;

afterEach(async () => {
  if (homeWasSet) {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    homeWasSet = false;
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

async function runCli(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<unknown> {
  if (!contextTreePackage) throw new Error("the Context Tree package must resolve");
  const { stdout } = await execFileAsync(process.execPath, [contextTreePackage.cliPath, ...args], {
    encoding: "utf8",
    env: environment,
  });
  return JSON.parse(stdout.trim());
}

/**
 * An isolated OS account home with one real Context Tree inside it. `finish-write` commits with
 * the host Git identity, so configuring one is part of reproducing a usable machine.
 */
async function isolatedAccount(prefix: string): Promise<{
  accountHome: string;
  openTagHome: string;
  treePath: string;
  environment: NodeJS.ProcessEnv;
  manager: ContextTreeManager;
}> {
  const accountHome = await temporaryDirectory(`${prefix}-account-`);
  await writeFile(
    join(accountHome, ".gitconfig"),
    "[user]\n\tname = OpenTag Test\n\temail = opentag-test@localhost\n[init]\n\tdefaultBranch = master\n",
    "utf8",
  );
  const environment: NodeJS.ProcessEnv = { HOME: accountHome, PATH: process.env.PATH };
  const seed = await temporaryDirectory(`${prefix}-seed-`);
  const { treePath } = (await runCli(["create", "--project-path", seed], environment)) as { treePath: string };

  previousHome = process.env.HOME;
  homeWasSet = true;
  process.env.HOME = accountHome;

  const openTagHome = await temporaryDirectory(`${prefix}-home-`);
  const layout = resolveOpenTagHomeLayout(openTagHome);
  await mkdir(layout.config, { mode: 0o700, recursive: true });
  await writeFile(
    layout.contextTreeConfigFile,
    `${JSON.stringify({ schemaVersion: 1, target: { kind: "path", path: treePath } })}\n`,
    "utf8",
  );
  const manager = new ContextTreeManager({
    home: openTagHome,
    ...(contextTreePackage ? { contextTreePackage } : {}),
  });
  return { accountHome, openTagHome, treePath, environment, manager };
}

/** Write one member memory node through the real isolated-worktree protocol. */
async function recordMemberMemory(worktreePath: string, slug: string, memory: string): Promise<void> {
  const directory = join(worktreePath, "members", slug);
  await mkdir(directory, { recursive: true });
  const node = (title: string, body: string) => `---\ntitle: "${title}"\n---\n\n# ${title}\n\n${body}\n`;
  await writeFile(join(directory, "NODE.md"), node(slug, "- **[memory.md](memory.md)** — private working memory."));
  await writeFile(join(directory, "memory.md"), node(`${slug} Memory`, memory));
  await writeFile(
    join(worktreePath, "members", "NODE.md"),
    node("Members", `- **[${slug}/](${slug}/NODE.md)** — ${slug} memory.`),
  );
}

describe("Context Tree end-to-end", () => {
  it("connects two Agent workspaces on one Computer to the same shared tree", async () => {
    const { accountHome, treePath, manager } = await isolatedAccount("opentag-ct-share");
    // The CLI installs Codex skills only for a host that is present. Simulate an installed Codex.
    await mkdir(join(accountHome, ".codex"), { mode: 0o700, recursive: true });
    const workspaceA = await temporaryDirectory("opentag-ct-agent-a-");
    const workspaceB = await temporaryDirectory("opentag-ct-agent-b-");

    const first = await manager.ensureAgent(workspaceA);
    expect(first).toEqual({ status: "ready", treePath });
    // Sharing one tree across Agents is the point of the feature, so both must land on it.
    await expect(manager.ensureAgent(workspaceB)).resolves.toEqual(first);

    // Each workspace carries the skills Claude Code discovers under `--setting-sources project`.
    for (const workspace of [workspaceA, workspaceB]) {
      await expect(
        readFile(join(workspace, ".claude", "skills", "context-tree-read", "SKILL.md"), "utf8"),
      ).resolves.toContain("context-tree");
    }
    await expect(
      readFile(join(accountHome, ".codex", "skills", "context-tree-write", "SKILL.md"), "utf8"),
    ).resolves.toContain("context-tree");

    // Exactly what a Session does: run the bare command name with the shim directory on PATH.
    const { stdout } = await execFileAsync("context-tree", ["resolve", "--project-path", workspaceA], {
      encoding: "utf8",
      env: { HOME: accountHome, PATH: `${manager.binDirectory()}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(JSON.parse(stdout.trim())).toMatchObject({ tree: { path: treePath } });
  });

  it("installs Codex skills into a custom CODEX_HOME named .codex", async () => {
    const { accountHome, openTagHome, treePath } = await isolatedAccount("opentag-ct-codex-home");
    const customRoot = await temporaryDirectory("opentag-custom-codex-root-");
    const codexHome = join(customRoot, ".codex");
    await mkdir(codexHome, { mode: 0o700, recursive: true });
    const manager = new ContextTreeManager({
      codexHome,
      home: openTagHome,
      ...(contextTreePackage ? { contextTreePackage } : {}),
    });

    await expect(manager.ensureAgent(await temporaryDirectory("opentag-ct-custom-codex-agent-"))).resolves.toEqual({
      status: "ready",
      treePath,
    });
    await expect(readFile(join(codexHome, "skills", "context-tree-read", "SKILL.md"), "utf8")).resolves.toContain(
      "context-tree",
    );
    // The install lands in the custom home, never in the OS account home.
    await expect(
      readFile(join(accountHome, ".codex", "skills", "context-tree-read", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports an unsupported CODE_HOME instead of misinstalling skills", async () => {
    const { accountHome, openTagHome } = await isolatedAccount("opentag-ct-codex-home-unsupported");
    const customRoot = await temporaryDirectory("opentag-custom-codex-root-");
    // The supported configuration from the review: a Codex home whose basename is not `.codex`,
    // with a sibling `.codex` that must never be written by the HOME redirect.
    const codexHome = join(customRoot, "codex-home");
    await mkdir(codexHome, { mode: 0o700, recursive: true });
    await mkdir(join(customRoot, ".codex"), { mode: 0o700, recursive: true });
    const manager = new ContextTreeManager({
      codexHome,
      home: openTagHome,
      ...(contextTreePackage ? { contextTreePackage } : {}),
    });

    await expect(manager.ensureAgent(await temporaryDirectory("opentag-ct-custom-codex-agent-"))).resolves.toEqual({
      status: "unavailable",
      reason: "CODEX_HOME_UNSUPPORTED",
    });
    // Nothing may land in the configured Codex home, in the sibling `.codex`, or in the account home.
    for (const root of [codexHome, join(customRoot, ".codex"), join(accountHome, ".codex")]) {
      await expect(readFile(join(root, "skills", "context-tree-read", "SKILL.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("lets one Agent record member memory that another Agent then reads", async () => {
    const { accountHome, treePath, environment, manager } = await isolatedAccount("opentag-ct-write");
    // The CLI installs Codex skills only for a host that is present; this account simulates one,
    // so preparation reaches `ready` and the memory write below is the point of the test.
    await mkdir(join(accountHome, ".codex"), { mode: 0o700, recursive: true });
    const writer = await temporaryDirectory("opentag-ct-writer-");
    const reader = await temporaryDirectory("opentag-ct-reader-");
    await expect(manager.ensureAgent(writer)).resolves.toMatchObject({ status: "ready" });
    await expect(manager.ensureAgent(reader)).resolves.toMatchObject({ status: "ready" });

    const { worktreePath } = (await runCli(["prepare-write", "--project-path", writer], environment)) as {
      worktreePath: string;
    };
    await recordMemberMemory(worktreePath, "researcher-agent", "Prefer the repository formatter.");
    const message = "docs(memory): record the formatter preference";
    await runCli(
      ["finish-write", "--worktree-path", worktreePath, "--message", message, "--project-path", writer],
      environment,
    );

    // Agent B, in a different workspace, reads it from the shared tree.
    const read = (await runCli(
      ["read", "members/researcher-agent/memory.md", "--tree-path", treePath],
      environment,
    )) as { node: { body: string } };
    expect(read.node.body).toContain("Prefer the repository formatter");
  });

  it("keeps a Session startable when the configured tree has been removed", async () => {
    const { treePath, manager } = await isolatedAccount("opentag-ct-gone");
    await rm(treePath, { force: true, recursive: true });

    // Optional memory: a destroyed tree is reported, never thrown.
    const status = await manager.ensureAgent(await temporaryDirectory("opentag-ct-agent-gone-"));
    expect(status.status).toBe("unavailable");
  });
});
