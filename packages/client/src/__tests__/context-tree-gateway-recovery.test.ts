import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextTreeSelector } from "@opentag/shared";
import { afterEach, expect, it } from "vitest";
import { createWorkspaceArchive, restoreWorkspaceArchive } from "../runner/workspace-archive.js";
import { cloudContextTreeGatewayFixture } from "./support/cloud-context-tree-gateway.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ot-cloud-tree-recovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const f = await cloudContextTreeGatewayFixture(root, join(root, "workspace"));
  cleanups.push(() => f.close());
  return f;
}

it("recovers Cloud gateway routing and uncertain publication from the archived workspace", async () => {
  const f = await fixture();
  const gateway = f.gateway();
  for (const source of f.sources)
    expect((await gateway.run(["sync", "--tree", contextTreeSelector(source)])).code).toBe(0);
  const prepared = JSON.parse(
    (await gateway.run(["write", "prepare", "--tree", contextTreeSelector(f.sources[0])])).stdout,
  );
  const other = JSON.parse(
    (await gateway.run(["write", "prepare", "--tree", contextTreeSelector(f.sources[1])])).stdout,
  );
  await writeFile(join(prepared.treeRoot, "decision.md"), "---\ntitle: Decision\n---\nUse MCP for GitHub.\n");
  const hint = await readFile(f.hintPath(prepared.id), "utf8");
  expect(hint).not.toContain("tree-local-handle");
  expect((await stat(f.hintPath(prepared.id))).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.workspace, ".opentag/context-tree/command-sessions"))).mode & 0o777).toBe(0o700);
  await writeFile(f.dropAck, "drop once");
  expect((await gateway.run(["write", "finish", prepared.id, "--message", "docs: decision", "--publish"])).code).toBe(
    1,
  );
  const committed = await f.git("--git-dir", f.remote, "rev-parse", "main");
  expect(await f.git("--git-dir", f.remote, "show", "main:docs/decision.md")).toContain("Use MCP for GitHub.");
  expect((await readFile(f.pushes, "utf8")).trim().split("\n")).toHaveLength(1);
  await gateway.close();
  const archive = join(f.root, "workspace.tar.gz"),
    info = await createWorkspaceArchive(f.workspace, archive);
  await rm(f.workspace, { recursive: true, force: true });
  await rm(join(f.root, "host-routing"), { recursive: true, force: true });
  await restoreWorkspaceArchive(archive, f.workspace, info);
  const later = f.gateway({ stateDirectory: join(f.root, "fresh-host-routing") });
  for (const invalid of ["not JSON", "x".repeat(4097)]) {
    await writeFile(f.hintPath(prepared.id), invalid);
    await expect(
      later.run(["write", "finish", prepared.id, "--message", "docs: decision", "--publish"]),
    ).rejects.toThrow();
  }
  await writeFile(f.hintPath(prepared.id), hint);
  for (const selected of [[f.sources[1]], [{ ...f.sources[0], ref: "changed" }, f.sources[1]]]) {
    later.configure(f.workspace, selected);
    await expect(
      later.run(["write", "finish", prepared.id, "--message", "docs: decision", "--publish"]),
    ).rejects.toThrow("no longer configured");
  }
  later.configure(f.workspace, f.sources);
  expect((await readFile(f.pushes, "utf8")).trim().split("\n")).toHaveLength(1);
  expect((await later.run(["write", "abort", other.id])).code).toBe(0);
  const empty = JSON.parse((await later.run(["write", "prepare", "--tree", contextTreeSelector(f.sources[1])])).stdout);
  expect(
    JSON.parse((await later.run(["write", "finish", empty.id, "--message", "docs: unchanged", "--publish"])).stdout)
      .outcome,
  ).toBe("unchanged");
  await expect(stat(f.hintPath(empty.id))).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    JSON.parse((await later.run(["write", "finish", prepared.id, "--message", "docs: decision", "--publish"])).stdout)
      .outcome,
  ).toBe("published");
  expect(await f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(committed);
  expect((await readFile(f.pushes, "utf8")).trim().split("\n")).toHaveLength(2);
  await expect(stat(f.hintPath(prepared.id))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(f.root, "fresh-host-routing"))).rejects.toMatchObject({ code: "ENOENT" });
}, 60000);

it.each(["prepare", "abort"] as const)(
  "settles a confirmed %s hint after cancellation and joins it on close",
  async (operation) => {
    const f = await fixture(),
      source = f.sources[0];
    const setup = f.gateway();
    await setup.run(["sync", "--tree", contextTreeSelector(source)]);
    const previous =
      operation === "abort"
        ? JSON.parse((await setup.run(["write", "prepare", "--tree", contextTreeSelector(source)])).stdout)
        : undefined;
    await setup.close();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = new AbortController();
    let closing: Promise<void> | undefined,
      closed = false;
    const gateway = f.gateway({
      execute: async (...args) => {
        const result = await f.execute(...args);
        if (args[0][1] === operation) {
          controller.abort();
          closing = gateway.close().then(() => {
            closed = true;
          });
        }
        return result;
      },
      sessionHints: {
        ...f.hints,
        write: async (id, hint) => {
          enter();
          await gate;
          await f.hints.write(id, hint);
        },
        remove: async (id) => {
          enter();
          await gate;
          await f.hints.remove(id);
        },
      },
    });
    const pending = gateway.run(
      operation === "prepare"
        ? ["write", "prepare", "--tree", contextTreeSelector(source)]
        : ["write", "abort", previous.id],
      controller.signal,
    );
    try {
      await entered;
      expect(closed).toBe(false);
      release();
      const result = await pending;
      expect(result.code).toBe(0);
      await closing;
      if (operation === "prepare") {
        const session = JSON.parse(result.stdout);
        expect(JSON.parse(await readFile(f.hintPath(session.id), "utf8"))).toMatchObject({ id: session.id, source });
        expect((await f.gateway().run(["write", "abort", session.id])).code).toBe(0);
      } else await expect(stat(f.hintPath(previous.id))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await pending;
      await closing;
    }
  },
  60000,
);
