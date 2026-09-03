import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextTreePackage } from "@opentag/client";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real child-process Context Tree cases need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import { registerContextTreeCommand } from "../commands/context-tree.js";
import { type ContextTreeConnectOptions, runContextTreeConnect } from "../core/context-tree/connect.js";
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

function capture(): { deps: { stdout: (chunk: string) => void; stderr: (chunk: string) => void }; text: () => string } {
  const chunks: string[] = [];
  const push = (chunk: string) => chunks.push(chunk);
  return { deps: { stdout: push, stderr: push }, text: () => chunks.join("") };
}

const listing = (names: readonly string[]) => ({
  payload: { schemaVersion: 1, trees: names.map((name) => ({ name, tree: { kind: "local", path: `/t/${name}` } })) },
});
const configFile = (home: string) => join(home, "config", "context-tree.json");
const invalid = { findings: [{ code: "MISSING_ROOT" }], ok: false };

describe("opentag context-tree connect", () => {
  it("records a validated managed target with owner-only permissions", async () => {
    const home = await temporaryDirectory("opentag-ct-connect-");
    const { deps, text } = capture();

    const result = await runContextTreeConnect({
      ...deps,
      home,
      target: "team-context-tree",
      contextTreePackage: await fakeCli({ list: listing(["team-context-tree"]) }),
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(JSON.parse(await readFile(configFile(home), "utf8"))).toEqual({
      schemaVersion: 1,
      target: { kind: "managed", name: "team-context-tree" },
    });
    expect((await stat(configFile(home))).mode & 0o777).toBe(0o600);
    expect(text()).toContain("team-context-tree");
  });

  it("accepts a GitHub target without network work, and says who clones it", async () => {
    const home = await temporaryDirectory("opentag-ct-github-");
    const { deps, text } = capture();

    await expect(
      runContextTreeConnect({ ...deps, home, target: "acme/shared-context", contextTreePackage: await fakeCli({}) }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(text()).toContain("first Agent Session clones it");
  });

  // A CLI that resolved but is not on disk fails the same way a missing package does.
  const absent = { root: "/nowhere", cliPath: "/nowhere/dist/cli/index.mjs", skillsPath: "/nowhere/skills" };
  const rejections: readonly [string, ContextTreeConnectOptions, Record<string, unknown>, string][] = [
    ["a managed name with no such tree", { target: "absent" }, { list: listing(["other"]) }, 'named "absent"'],
    ["a path that is not a tree", { treePath: "/srv/x" }, { verify: { payload: invalid } }, "MISSING_ROOT"],
    ["a CLI that is not on disk", { target: "team", contextTreePackage: absent }, {}, "Could not list"],
  ];

  it.each(rejections)("exits 1 and records nothing for %s", async (_label, options, responses, explains) => {
    const home = await temporaryDirectory("opentag-ct-reject-");
    const { deps, text } = capture();
    const contextTreePackage = options.contextTreePackage ?? (await fakeCli(responses));

    await expect(runContextTreeConnect({ ...deps, ...options, contextTreePackage, home })).resolves.toEqual({
      exitCode: 1,
    });
    expect(text()).toContain(explains);
    await expect(readFile(configFile(home), "utf8")).rejects.toThrow();
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
    const { deps, text } = capture();
    const program = new Command().exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerContextTreeCommand(program, { ...deps, home: await temporaryDirectory("opentag-ct-cmd-") });

    await expect(
      program.parseAsync(["node", "opentag", "context-tree", "connect", "Not A Name"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(text()).toContain("is not a managed Context Tree name");
  });
});

describe("readContextTreeState", () => {
  const path = { kind: "path", path: "/srv/tree" };
  const managed = { kind: "managed", name: "team" };
  const verified = (ok: boolean) => ({ payload: { findings: ok ? [] : [{ code: "DIRTY" }], ok } });

  const noSuchTree = "the named managed Context Tree does not exist";

  it.each([
    ["no target when nothing is configured", undefined, {}, { tree: "unknown" }],
    ["a verified path target", path, { verify: verified(true) }, { target: "/srv/tree", tree: "valid" }],
    ["an unusable path", path, { verify: verified(false) }, { detail: "DIRTY", target: "/srv/tree", tree: "invalid" }],
    ["a managed tree that exists", managed, { list: listing(["team"]) }, { target: "team", tree: "valid" }],
    [
      "a managed tree that does not",
      managed,
      { list: listing([]) },
      { detail: noSuchTree, target: "team", tree: "invalid" },
    ],
    // Nobody has cloned it yet, which is expected rather than broken.
    [
      "an uncloned GitHub target",
      { kind: "github", repository: "a/b" },
      { list: listing([]) },
      { target: "a/b", tree: "not-cloned" },
    ],
  ])("reports %s", async (_label, target, responses, expected) => {
    const home = await temporaryDirectory("opentag-ct-state-");
    if (target !== undefined) {
      await mkdir(join(home, "config"), { mode: 0o700, recursive: true });
      await writeFile(configFile(home), JSON.stringify({ schemaVersion: 1, target }), "utf8");
    }

    const { configPath, ...state } = await readContextTreeState({ home, contextTreePackage: await fakeCli(responses) });
    expect(configPath).toBe(configFile(home));
    expect(state).toEqual(expected);
  });

  it("treats unreadable configuration as unknown rather than failing", async () => {
    const home = await temporaryDirectory("opentag-ct-state-bad-");
    await mkdir(join(home, "config"), { mode: 0o700, recursive: true });
    await writeFile(configFile(home), "{ not json", "utf8");

    await expect(readContextTreeState({ home, contextTreePackage: await fakeCli({}) })).resolves.toMatchObject({
      tree: "unknown",
    });
  });

  it("reports a recorded unavailable GitHub preparation as invalid", async () => {
    const home = await temporaryDirectory("opentag-ct-state-preparation-");
    await mkdir(join(home, "config"), { mode: 0o700, recursive: true });
    await mkdir(join(home, "state"), { mode: 0o700, recursive: true });
    await writeFile(
      configFile(home),
      JSON.stringify({ schemaVersion: 1, target: { kind: "github", repository: "acme/missing" } }),
      "utf8",
    );
    await writeFile(
      join(home, "state", "context-tree-preparation.json"),
      JSON.stringify({
        schemaVersion: 1,
        target: "acme/missing",
        status: "unavailable",
        reason: "GITHUB_AUTH",
        at: new Date().toISOString(),
      }),
      "utf8",
    );

    await expect(
      readContextTreeState({ home, contextTreePackage: await fakeCli({ list: listing([]) }) }),
    ).resolves.toMatchObject({ target: "acme/missing", tree: "invalid", detail: "GITHUB_AUTH" });
  });
});
