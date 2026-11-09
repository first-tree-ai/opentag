import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_TREE_COMMAND_WORKER_SOURCE } from "../runner/context-tree-command-worker.js";
import { collectDescendantPids } from "../runner/processes.js";
import { resolveContextTreePackage } from "../runtime/context-tree.js";
import { configureContextTrees } from "../runtime/context-tree-connections.js";

const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));
async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return value.slice(value.lastIndexOf(") ") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

async function stopOwned(worker: ReturnType<typeof spawn>, gitPid: number | undefined): Promise<void> {
  const descendants = worker.pid ? await collectDescendantPids(worker.pid) : [];
  for (const pid of [...descendants, ...(gitPid ? [gitPid] : [])]) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
  }
  worker.kill("SIGKILL");
}

describe("Cloud Context Tree process ownership", () => {
  it.each([false, true])(
    "cancels detached Git descendants before finishing (ignores TERM=%s)",
    async (ignoreTerm) => {
      const root = await mkdtemp(join(tmpdir(), "ot-tree-worker-stop-"));
      const workspace = join(root, "workspace"),
        bin = join(root, "bin"),
        pidFile = join(root, "git.pid"),
        marker = join(root, "late-write");
      const pack = resolveContextTreePackage();
      if (!pack) throw new Error("Missing pinned CLI");
      await mkdir(bin);
      const project = await configureContextTrees(workspace, [
        { kind: "git", repository: "fixture/tree", path: ".", ref: "main" },
      ]);
      await writeFile(
        join(bin, "git"),
        `#!${process.execPath}\nconst fs = require('node:fs');\n${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'continued after cancellation'), 1500);\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      const worker = spawn(process.execPath, ["--input-type=module", "-e", CONTEXT_TREE_COMMAND_WORKER_SOURCE], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closed = once(worker, "close", { signal: AbortSignal.timeout(10000) });
      let output = "";
      worker.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      worker.stderr.resume();
      let gitPid: number | undefined;
      try {
        worker.stdin.end(
          JSON.stringify({
            cli: pack.cliPath,
            args: ["sync", "--project-path", project],
            cwd: workspace,
            environment: { HOME: root, PATH: `${bin}:${process.env.PATH}` },
          }),
        );
        await expect
          .poll(async () => {
            try {
              gitPid = Number(await readFile(pidFile, "utf8"));
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
        worker.kill("SIGTERM");
        await closed;
        expect(JSON.parse(output).code).toBe(1);
        expect(gitPid).toBeDefined();
        expect(await running(gitPid as number)).toBe(false);
        await pause(1700);
        await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await stopOwned(worker, gitPid);
        await closed.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
    20000,
  );
});
