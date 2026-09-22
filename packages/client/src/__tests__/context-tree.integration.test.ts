import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextTreeManager, resolveContextTreePackage } from "../runtime/context-tree.js";
import { resolveContextTreeHome } from "../storage/context-tree-home.js";

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
  try {
    const { stdout } = await execFileAsync(process.execPath, [contextTreePackage.cliPath, ...args], {
      encoding: "utf8",
      env: environment,
    });
    return JSON.parse(stdout.trim());
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`Context Tree CLI failed: ${detail.stderr || detail.stdout || detail.message || "no output"}`);
  }
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
  const accountHome = await realpath(await temporaryDirectory(`${prefix}-account-`));
  await writeFile(
    join(accountHome, ".gitconfig"),
    "[user]\n\tname = OpenTag Test\n\temail = opentag-test@localhost\n[init]\n\tdefaultBranch = master\n",
    "utf8",
  );
  const gitBin = await temporaryDirectory(`${prefix}-git-bin-`);
  const gitShim = join(gitBin, "git");
  const environment: NodeJS.ProcessEnv = { HOME: accountHome, PATH: `${gitBin}${delimiter}${process.env.PATH ?? ""}` };
  const seed = await temporaryDirectory(`${prefix}-seed-`);
  const { treePath } = (await runCli(["create", "--project-path", seed, "--json"], environment)) as {
    treePath: string;
  };
  await execFileAsync("/usr/bin/git", ["-C", treePath, "config", "receive.denyCurrentBranch", "updateInstead"]);

  previousHome = process.env.HOME;
  homeWasSet = true;
  process.env.HOME = accountHome;

  const openTagHome = await temporaryDirectory(`${prefix}-home-`);
  // The real CLI verifies the clone's origin remains GitHub-shaped. Intercept just this fixture's
  // clone, then restore the requested origin so its production identity check still executes.
  await writeFile(
    gitShim,
    `#!/bin/sh
root=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-C" ]; then root="$argument"; fi
  previous="$argument"
done
case " $* " in
  *" clone "*)
    set -- $@
    for argument in "$@"; do destination="$argument"; done
    /usr/bin/git -C "$root" clone --quiet --origin origin -- "file://${treePath}" "$destination" || exit $?
    /usr/bin/git -C "$destination" remote set-url origin "https://github.com/acme/memory.git"
    exit $?
    ;;
  *" fetch "*|*" push "*|*" pull "*)
    exec /usr/bin/git -c "url.file://${treePath}.insteadOf=https://github.com/acme/memory.git" "$@"
    ;;
esac
if [ "$1" = "-C" ]; then
  shift 2
fi
if [ "$1" = clone ]; then
  for argument in "$@"; do destination="$argument"; done
  /usr/bin/git -C "$root" clone --quiet --origin origin -- "file://${treePath}" "$destination" || exit $?
  /usr/bin/git -C "$destination" remote set-url origin "https://github.com/acme/memory.git"
  exit $?
fi
if [ -n "$root" ]; then exec /usr/bin/git -C "$root" "$@"; fi
exec /usr/bin/git "$@"
`,
    "utf8",
  );
  await chmod(gitShim, 0o700);
  const connected = (await runCli(["connect", "acme/memory", "--project-path", seed, "--json"], environment)) as {
    tree: { path: string };
  };
  const manager = new ContextTreeManager({
    environment,
    home: openTagHome,
    ...(contextTreePackage ? { contextTreePackage } : {}),
  });
  return { accountHome, openTagHome, treePath: connected.tree.path, environment, manager };
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
  it("provides the bundled command before configuration without connecting or creating a tree", async () => {
    const home = await temporaryDirectory("opentag-ct-unconfigured-");
    const cwd = await temporaryDirectory("opentag-ct-unconfigured-agent-");
    previousHome = process.env.HOME;
    homeWasSet = true;
    process.env.HOME = home;
    const manager = new ContextTreeManager({ home });
    await expect(manager.ensureAgent(cwd)).resolves.toEqual({ status: "unconfigured" });
    const { stdout } = await execFileAsync("/bin/sh", ["-c", "context-tree --version"], {
      cwd,
      env: { HOME: home, PATH: manager.binDirectory() },
    });
    expect(stdout.trim()).not.toBe("");
    expect(await readdir(cwd)).toEqual([]);
    await expect(
      readFile(join(resolveContextTreeHome({ HOME: home }).directory, "opentag.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(home)).toContain("context-tree");
  });

  it("connects two Agent workspaces on one Computer to the same shared tree", async () => {
    const { accountHome, treePath, manager } = await isolatedAccount("opentag-ct-share");
    // The CLI installs Codex skills only for a host that is present. Simulate an installed Codex.
    await mkdir(join(accountHome, ".codex"), { mode: 0o700, recursive: true });
    const workspaceA = await temporaryDirectory("opentag-ct-agent-a-");
    const workspaceB = await temporaryDirectory("opentag-ct-agent-b-");

    const first = await manager.ensureAgent(workspaceA, "codex", [{ alias: "memory", repository: "acme/memory" }]);
    expect(first).toMatchObject({
      status: "configured",
      connections: [{ alias: "memory", repository: "acme/memory", status: "ready", treePath }],
    });
    // Sharing one tree across Agents is the point of the feature, so both must land on it.
    await expect(
      manager.ensureAgent(workspaceB, "codex", [{ alias: "memory", repository: "acme/memory" }]),
    ).resolves.toEqual(first);

    for (const workspace of [workspaceA, workspaceB]) {
      for (const file of ["AGENTS.md", "CLAUDE.md"]) {
        await expect(readFile(join(workspace, file))).rejects.toMatchObject({ code: "ENOENT" });
      }
    }

    // Each workspace carries the skills Claude Code discovers under `--setting-sources project`.
    for (const workspace of [workspaceA, workspaceB]) {
      await expect(
        readFile(join(workspace, ".claude", "skills", "context-tree-read", "SKILL.md"), "utf8"),
      ).resolves.toContain("context-tree");
    }
    await expect(
      readFile(join(accountHome, ".agents", "skills", "context-tree-write", "SKILL.md"), "utf8"),
    ).resolves.toContain("context-tree");

    // Exactly what a Session does: run the bare command name with the shim directory on PATH.
    const { stdout } = await execFileAsync("context-tree", ["resolve", "--project-path", workspaceA, "--json"], {
      encoding: "utf8",
      env: { HOME: accountHome, PATH: `${manager.binDirectory()}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(JSON.parse(stdout.trim())).toMatchObject({
      schemaVersion: 2,
      connections: [{ alias: "memory", tree: { path: treePath } }],
    });
  });

  it.each([".codex", "codex-home"])("installs skills into account HOME with custom CODEX_HOME %s", async (name) => {
    const { accountHome, openTagHome, treePath, environment } = await isolatedAccount("opentag-ct-codex-home");
    const customRoot = await temporaryDirectory("opentag-custom-codex-root-");
    const codexHome = join(customRoot, name);
    await mkdir(codexHome, { mode: 0o700, recursive: true });
    const manager = new ContextTreeManager({
      environment,
      codexHome,
      home: openTagHome,
      ...(contextTreePackage ? { contextTreePackage } : {}),
    });

    await expect(
      manager.ensureAgent(await temporaryDirectory("opentag-ct-custom-codex-agent-"), "codex", [
        { alias: "memory", repository: "acme/memory" },
      ]),
    ).resolves.toMatchObject({ status: "configured", connections: [{ status: "ready", treePath }] });
    await expect(
      readFile(join(accountHome, ".agents", "skills", "context-tree-read", "SKILL.md"), "utf8"),
    ).resolves.toContain("context-tree");
    // Codex scans the account home, independently of where its configuration lives.
    await expect(
      readFile(join(customRoot, ".agents", "skills", "context-tree-read", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lets one Agent record member memory that another Agent then reads", async () => {
    const { accountHome, treePath, environment, manager } = await isolatedAccount("opentag-ct-write");
    // The CLI installs Codex skills only for a host that is present; this account simulates one,
    // so preparation reaches `ready` and the memory write below is the point of the test.
    await mkdir(join(accountHome, ".codex"), { mode: 0o700, recursive: true });
    const writer = await temporaryDirectory("opentag-ct-writer-");
    const reader = await temporaryDirectory("opentag-ct-reader-");
    await expect(
      manager.ensureAgent(writer, "codex", [{ alias: "memory", repository: "acme/memory" }]),
    ).resolves.toMatchObject({ connections: [{ status: "ready" }] });
    await expect(
      manager.ensureAgent(reader, "codex", [{ alias: "memory", repository: "acme/memory" }]),
    ).resolves.toMatchObject({ connections: [{ status: "ready" }] });

    const { worktreePath } = (await runCli(["prepare-write", "--project-path", writer], environment)) as {
      worktreePath: string;
    };
    await recordMemberMemory(worktreePath, "researcher-agent", "Prefer the repository formatter.");
    const message = "docs(memory): record the formatter preference";
    await runCli(
      ["finish-write", "--worktree-path", worktreePath, "--message", message, "--project-path", writer],
      environment,
    );
    if (!contextTreePackage) throw new Error("the Context Tree package must resolve");
    await execFileAsync(process.execPath, [contextTreePackage.cliPath, "sync", "--project-path", reader], {
      env: environment,
    });

    // Agent B, in a different workspace, reads it from the shared tree.
    const read = (await runCli(
      ["read", "members/researcher-agent/memory.md", "--tree-path", treePath, "--json"],
      environment,
    )) as { node: { body: string } };
    expect(read.node.body).toContain("Prefer the repository formatter");
  });

  it("keeps a Session startable when the configured tree has been removed", async () => {
    const { treePath, manager } = await isolatedAccount("opentag-ct-gone");
    await writeFile(join(treePath, "NODE.md"), "invalid tree");

    // Optional memory: a destroyed tree is reported, never thrown.
    const status = await manager.ensureAgent(await temporaryDirectory("opentag-ct-agent-gone-"), "codex", [
      { alias: "memory", repository: "acme/memory" },
    ]);
    expect(status).toMatchObject({ connections: [{ status: "unavailable" }] });
  });
});

it("connects two named trees offline, writes explicitly to one and keeps the other usable after disconnect", async () => {
  const home = await temporaryDirectory("opentag-multi-tree-account-");
  const environment = {
    HOME: home,
    PATH: process.env.PATH,
    GIT_AUTHOR_NAME: "OpenTag Test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "OpenTag Test",
    GIT_COMMITTER_EMAIL: "test@localhost",
  };
  const workspace = await temporaryDirectory("opentag-multi-tree-project-");
  const first = (await runCli(
    ["create", "--name", "team", "--as", "team", "--project-path", workspace, "--json"],
    environment,
  )) as { treePath: string };
  const second = (await runCli(
    ["create", "--name", "product", "--as", "product", "--project-path", workspace, "--json"],
    environment,
  )) as { treePath: string };
  expect(first.treePath).not.toBe(second.treePath);
  const before = await readFile(join(second.treePath, "NODE.md"), "utf8");
  const prepared = (await runCli(["prepare-write", "--tree", "team", "--project-path", workspace], environment)) as {
    worktreePath: string;
  };
  await recordMemberMemory(prepared.worktreePath, "tester", "Write destinations are explicit aliases.");
  await runCli(
    [
      "finish-write",
      "--tree",
      "team",
      "--worktree-path",
      prepared.worktreePath,
      "--message",
      "docs: record named memory",
      "--project-path",
      workspace,
    ],
    environment,
  );
  expect(await readFile(join(first.treePath, "members", "tester", "memory.md"), "utf8")).toContain("explicit aliases");
  expect(await readFile(join(second.treePath, "NODE.md"), "utf8")).toBe(before);
  await runCli(["disconnect", "--tree", "team", "--project-path", workspace, "--json"], environment);
  expect(await runCli(["sync", "--project-path", workspace], environment)).toMatchObject({
    schemaVersion: 2,
    connections: [{ alias: "product", ok: true }],
  });
  expect(await runCli(["read", "--tree-path", second.treePath, "--json"], environment)).toHaveProperty("node");
  expect(await readFile(join(first.treePath, "members", "tester", "memory.md"), "utf8")).toContain("explicit aliases");
});
