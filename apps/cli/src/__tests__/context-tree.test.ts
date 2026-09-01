import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextTreePackage } from "@opentag/client";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerContextTreeCommand } from "../commands/context-tree.js";
import { runContextTreeConnect } from "../core/context-tree/connect.js";
import { ContextTreeUsageError } from "../core/context-tree/shared.js";
import { readContextTreeState } from "../core/context-tree/state.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

/**
 * A stand-in for the packaged CLI: a real script, invoked the real way, answering each subcommand
 * from a canned table. This exercises the production invocation path rather than mocking it out.
 */
async function fakeCli(responses: Readonly<Record<string, unknown>>): Promise<ContextTreePackage> {
  const root = await temporaryDirectory("opentag-ct-fake-cli-");
  await mkdir(join(root, "dist", "cli"), { recursive: true });
  const cliPath = join(root, "dist", "cli", "index.mjs");
  await writeFile(
    cliPath,
    `const table = ${JSON.stringify(responses)};
const entry = table[process.argv[2]];
if (entry === undefined) { process.stdout.write(JSON.stringify({ error: { code: "UNKNOWN", message: "" }, ok: false })); process.exit(1); }
process.stdout.write(JSON.stringify(entry.payload));
process.exit(entry.exitCode ?? 0);
`,
    "utf8",
  );
  return { root, cliPath, skillsPath: join(root, "skills") };
}

function capture(): {
  deps: { stdout: (chunk: string) => void; stderr: (chunk: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { deps: { stdout: (chunk) => out.push(chunk), stderr: (chunk) => err.push(chunk) }, out, err };
}

const listing = (names: readonly string[]) => ({
  payload: { schemaVersion: 1, trees: names.map((name) => ({ name, tree: { kind: "local", path: `/t/${name}` } })) },
});

describe("opentag context-tree connect", () => {
  it("records a validated managed target with owner-only permissions", async () => {
    const home = await temporaryDirectory("opentag-ct-connect-");
    const { deps, out } = capture();

    const result = await runContextTreeConnect({
      ...deps,
      home,
      target: "team-context-tree",
      contextTreePackage: await fakeCli({ list: listing(["team-context-tree"]) }),
    });

    expect(result).toEqual({ exitCode: 0 });
    const configPath = join(home, "config", "context-tree.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      schemaVersion: 1,
      target: { kind: "managed", name: "team-context-tree" },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(out.join("")).toContain("team-context-tree");
  });

  it("refuses a managed name that does not exist, and a path that is not a tree", async () => {
    const home = await temporaryDirectory("opentag-ct-reject-");
    const missing = capture();
    await expect(
      runContextTreeConnect({
        ...missing.deps,
        home,
        target: "absent-tree",
        contextTreePackage: await fakeCli({ list: listing(["other-tree"]) }),
      }),
    ).resolves.toEqual({ exitCode: 1 });
    expect(missing.err.join("")).toContain('No managed Context Tree named "absent-tree"');

    const invalid = capture();
    await expect(
      runContextTreeConnect({
        ...invalid.deps,
        home,
        treePath: "/srv/not-a-tree",
        contextTreePackage: await fakeCli({
          verify: { payload: { findings: [{ code: "MISSING_ROOT" }], ok: false }, exitCode: 0 },
        }),
      }),
    ).resolves.toEqual({ exitCode: 1 });
    expect(invalid.err.join("")).toContain("MISSING_ROOT");

    // Neither rejection may leave configuration behind.
    await expect(readFile(join(home, "config", "context-tree.json"), "utf8")).rejects.toThrow();
  });

  it("accepts a GitHub target without network work, and says who clones it", async () => {
    const home = await temporaryDirectory("opentag-ct-github-");
    const { deps, out } = capture();

    await expect(
      runContextTreeConnect({ ...deps, home, target: "acme/shared-context", contextTreePackage: await fakeCli({}) }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(out.join("")).toContain("first Agent Session clones it");
  });

  it.each([
    [{ target: "team", treePath: "/srv/tree" }, "not both"],
    [{}, "is required"],
    [{ target: "Not A Name" }, "is not a managed Context Tree name"],
    [{ treePath: "relative/path" }, "is not a managed Context Tree name"],
  ])("rejects %j as a usage error", async (options, message) => {
    const home = await temporaryDirectory("opentag-ct-usage-");
    await expect(runContextTreeConnect({ ...options, home })).rejects.toThrow(ContextTreeUsageError);
    await expect(runContextTreeConnect({ ...options, home })).rejects.toThrow(message);
  });

  it("explains a usage error on stderr and exits 2 rather than failing silently", async () => {
    const { deps, err } = capture();
    const program = new Command().exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerContextTreeCommand(program, { ...deps, home: await temporaryDirectory("opentag-ct-cmd-") });

    await expect(
      program.parseAsync(["node", "opentag", "context-tree", "connect", "Not A Name"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(err.join("")).toContain("is not a managed Context Tree name");
  });

  it("reports a missing package instead of writing an unusable configuration", async () => {
    const home = await temporaryDirectory("opentag-ct-nopkg-");
    const { deps, err } = capture();
    const absent = { root: "/nowhere", cliPath: "/nowhere/dist/cli/index.mjs", skillsPath: "/nowhere/skills" };

    // A resolvable-but-absent CLI fails the same way a missing package does: nothing is recorded.
    await expect(
      runContextTreeConnect({ ...deps, home, target: "team-context-tree", contextTreePackage: absent }),
    ).resolves.toEqual({ exitCode: 1 });
    expect(err.join("")).not.toBe("");
    await expect(readFile(join(home, "config", "context-tree.json"), "utf8")).rejects.toThrow();
  });
});

describe("readContextTreeState", () => {
  async function stateFor(target: unknown, responses: Readonly<Record<string, unknown>>) {
    const home = await temporaryDirectory("opentag-ct-state-");
    if (target !== undefined) {
      await mkdir(join(home, "config"), { mode: 0o700, recursive: true });
      await writeFile(join(home, "config", "context-tree.json"), JSON.stringify({ schemaVersion: 1, target }), "utf8");
    }
    return readContextTreeState({ home, contextTreePackage: await fakeCli(responses) });
  }

  it("reports no target when nothing is configured", async () => {
    const state = await stateFor(undefined, {});
    expect(state.target).toBeUndefined();
    expect(state.tree).toBe("unknown");
  });

  it("verifies a path target and names the failure code when it is unusable", async () => {
    await expect(
      stateFor({ kind: "path", path: "/srv/tree" }, { verify: { payload: { ok: true, findings: [] } } }),
    ).resolves.toMatchObject({ target: "/srv/tree", tree: "valid" });
    await expect(
      stateFor(
        { kind: "path", path: "/srv/tree" },
        { verify: { payload: { ok: false, findings: [{ code: "DIRTY" }] } } },
      ),
    ).resolves.toMatchObject({ tree: "invalid", detail: "DIRTY" });
  });

  it("distinguishes a missing managed tree from a GitHub target nobody has cloned", async () => {
    await expect(stateFor({ kind: "managed", name: "team" }, { list: listing(["team"]) })).resolves.toMatchObject({
      tree: "valid",
    });
    await expect(stateFor({ kind: "managed", name: "team" }, { list: listing([]) })).resolves.toMatchObject({
      tree: "invalid",
    });
    await expect(stateFor({ kind: "github", repository: "acme/shared" }, { list: listing([]) })).resolves.toMatchObject(
      { tree: "not-cloned" },
    );
  });

  it("treats unreadable configuration as unknown rather than failing", async () => {
    const home = await temporaryDirectory("opentag-ct-state-bad-");
    await mkdir(join(home, "config"), { mode: 0o700, recursive: true });
    await writeFile(join(home, "config", "context-tree.json"), "{ not json", "utf8");

    await expect(readContextTreeState({ home, contextTreePackage: await fakeCli({}) })).resolves.toMatchObject({
      tree: "unknown",
    });
  });
});
