import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createSandboxContextTreeSessionHints } from "../runner/context-tree-session-hints.js";

const runFile = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it.skipIf(process.platform === "win32").each(["symlink", "directory", "fifo"] as const)(
  "rejects a %s routing hint without waiting for an I/O deadline",
  async (kind) => {
    const workspace = await mkdtemp(join(tmpdir(), "ot-hint-files-"));
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    const id = randomUUID(),
      root = join(workspace, ".opentag/context-tree/command-sessions"),
      outside = join(workspace, "outside");
    await mkdir(root, { recursive: true });
    const path = join(root, `${id}.json`);
    await writeFile(outside, "retained target");
    if (kind === "symlink") await symlink(outside, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "fifo") await runFile("mkfifo", [path]);
    const exits: (string | null | undefined)[] = [];
    const hints = createSandboxContextTreeSessionHints(
      {
        exec: async (_binary, args, options) => {
          const execution = runFile(process.execPath, [...args], {
            signal: options.signal,
            timeout: options.timeoutMs,
          });
          execution.child.stdin?.end(options.stdin);
          try {
            const result = await execution;
            exits.push(null);
            return { code: 0, stdout: result.stdout, stderr: result.stderr };
          } catch (error) {
            const result = error as { code?: number; signal?: string; stdout?: string; stderr?: string };
            exits.push(result.signal);
            return {
              code: typeof result.code === "number" ? result.code : 1,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
            };
          }
        },
      },
      workspace,
    );
    await expect(hints.read(id, AbortSignal.timeout(1000))).rejects.toThrow("routing hint unavailable");
    expect(exits).toEqual([null]);
    expect(await readFile(outside, "utf8")).toBe("retained target");
  },
);

it("rejects a late in-Sandbox hint result after caller cancellation", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const controller = new AbortController();
  const hints = createSandboxContextTreeSessionHints(
    {
      exec: async () => {
        enter();
        await gate;
        return { code: 0, stdout: JSON.stringify({ data: "retained hint" }), stderr: "" };
      },
    },
    "/workspace",
  );
  const pending = hints.read(randomUUID(), controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  try {
    await entered;
    controller.abort();
    release();
    await rejected;
  } finally {
    release();
    await rejected;
  }
});
