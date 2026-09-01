import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextTreeManager, resolveContextTreePackage } from "../runtime/context-tree.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

/**
 * End-to-end against the real packaged CLI and a real Git tree, offline throughout: the tree is a
 * local checkout, and `HOME` is redirected so the CLI's connection store, managed namespace, and
 * Codex skill directory are isolated from the developer's own.
 */

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

  it("lets one Agent record member memory that another Agent then reads", async () => {
    const { treePath, environment, manager } = await isolatedAccount("opentag-ct-write");
    const writer = await temporaryDirectory("opentag-ct-writer-");
    const reader = await temporaryDirectory("opentag-ct-reader-");
    await expect(manager.ensureAgent(writer)).resolves.toMatchObject({ status: "ready" });
    await expect(manager.ensureAgent(reader)).resolves.toMatchObject({ status: "ready" });

    // Agent A writes its own member memory through the real isolated-worktree protocol.
    const { worktreePath } = (await runCli(["prepare-write", "--project-path", writer], environment)) as {
      worktreePath: string;
    };
    const memberDirectory = join(worktreePath, "members", "researcher-agent");
    await mkdir(memberDirectory, { recursive: true });
    await writeFile(
      join(memberDirectory, "NODE.md"),
      '---\ntitle: "Researcher Agent"\n---\n\n# Researcher Agent\n\n- **[memory.md](memory.md)** — private working memory.\n',
      "utf8",
    );
    await writeFile(
      join(memberDirectory, "memory.md"),
      '---\ntitle: "Researcher Agent Memory"\n---\n\n# Researcher Agent Memory\n\nPrefer the repository formatter over ad-hoc tooling.\n',
      "utf8",
    );
    await writeFile(
      join(worktreePath, "members", "NODE.md"),
      '---\ntitle: "Members"\n---\n\n# Members\n\n- **[researcher-agent/](researcher-agent/NODE.md)** — Researcher Agent memory.\n',
      "utf8",
    );
    await runCli(
      [
        "finish-write",
        "--worktree-path",
        worktreePath,
        "--message",
        "docs(memory): record the formatter preference",
        "--project-path",
        writer,
      ],
      environment,
    );

    // Agent B, in a different workspace, reads it from the shared tree.
    const read = (await runCli(
      ["read", "members/researcher-agent/memory.md", "--tree-path", treePath],
      environment,
    )) as {
      node: { body: string };
    };
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
