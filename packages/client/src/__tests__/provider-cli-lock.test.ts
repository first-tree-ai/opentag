import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProviderCliAccountLayout,
  ProviderCliLockBusyError,
  providerCliLockFilePath,
  resolveProviderCliAccountLayout,
  withProviderCliLock,
} from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeLayout(): Promise<{ layout: ProviderCliAccountLayout; lockPath: string }> {
  const accountHome = await mkdtemp(join(tmpdir(), "opentag-provider-cli-lock-"));
  tempDirs.push(accountHome);
  const layout = resolveProviderCliAccountLayout(accountHome);
  await mkdir(layout.state, { recursive: true, mode: 0o700 });
  return { layout, lockPath: providerCliLockFilePath(layout, "feishu") };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** A PID that certainly belonged to a process which has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("child pid is required");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return pid;
}

const noSleep = async (): Promise<void> => undefined;

describe("withProviderCliLock", () => {
  it("writes an exclusive record for the duration of the operation and removes it afterwards", async () => {
    const { layout, lockPath } = await makeLayout();
    let observed: { pid: number; token: string } | undefined;
    const result = await withProviderCliLock(layout, "feishu", async () => {
      observed = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; token: string };
      return "done";
    });
    expect(result).toBe("done");
    expect(observed?.pid).toBe(process.pid);
    expect(observed?.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await exists(lockPath)).toBe(false);
  });

  it("releases the lock when the operation throws", async () => {
    const { layout, lockPath } = await makeLayout();
    await expect(
      withProviderCliLock(layout, "feishu", async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(await exists(lockPath)).toBe(false);
  });

  it("reports busy after exhausting attempts while a live holder keeps the lock", async () => {
    const { layout, lockPath } = await makeLayout();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }), { mode: 0o600 });
    const sleep = vi.fn(noSleep);
    const run = vi.fn(async () => "never");
    const attempt = withProviderCliLock(layout, "feishu", run, { sleep, maxAttempts: 3, retryDelayMs: 7 });
    await expect(attempt).rejects.toBeInstanceOf(ProviderCliLockBusyError);
    await expect(attempt).rejects.toMatchObject({
      name: "ProviderCliLockBusyError",
      message: "Another OpenTag process is modifying the feishu Provider CLI",
    });
    expect(run).not.toHaveBeenCalled();
    // The final attempt does not sleep before reporting busy.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({ pid: process.pid, token: "someone-else" });
  });

  it("treats a holder the daemon cannot signal as alive", async () => {
    const { layout } = await makeLayout();
    await writeFile(providerCliLockFilePath(layout, "slack"), JSON.stringify({ pid: 1, token: "init" }), {
      mode: 0o600,
    });
    await expect(
      withProviderCliLock(layout, "slack", async () => "never", { sleep: noSleep, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(ProviderCliLockBusyError);
  });

  it("honours an injected liveness probe and the default retry delay", async () => {
    const { layout, lockPath } = await makeLayout();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }), { mode: 0o600 });
    const isProcessAlive = vi.fn(() => true);
    const sleep = vi.fn(noSleep);
    await expect(
      withProviderCliLock(layout, "feishu", async () => "never", { isProcessAlive, sleep, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(ProviderCliLockBusyError);
    expect(isProcessAlive).toHaveBeenCalledTimes(2);
    expect(isProcessAlive).toHaveBeenCalledWith(process.pid);
    // No retryDelayMs was injected, so the retry waits for the 100ms default.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("breaks a lock whose holder process has exited", async () => {
    const { layout, lockPath } = await makeLayout();
    await writeFile(lockPath, JSON.stringify({ pid: await deadPid(), token: "gone" }), { mode: 0o600 });
    const sleep = vi.fn(noSleep);
    await expect(withProviderCliLock(layout, "feishu", async () => "ran", { sleep })).resolves.toBe("ran");
    expect(sleep).not.toHaveBeenCalled();
    expect(await exists(lockPath)).toBe(false);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a non-object document", "42"],
    ["a null document", "null"],
    ["a zero pid", JSON.stringify({ pid: 0, token: "t" })],
    ["a fractional pid", JSON.stringify({ pid: 1.5, token: "t" })],
    ["a string pid", JSON.stringify({ pid: "1", token: "t" })],
    ["a missing token", JSON.stringify({ pid: process.pid })],
    ["an empty token", JSON.stringify({ pid: process.pid, token: "" })],
  ])("breaks a stale lock containing %s", async (_label, content) => {
    const { layout, lockPath } = await makeLayout();
    await writeFile(lockPath, content, { mode: 0o600 });
    const isProcessAlive = vi.fn(() => true);
    await expect(
      withProviderCliLock(layout, "feishu", async () => "ran", { isProcessAlive, sleep: noSleep }),
    ).resolves.toBe("ran");
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(await exists(lockPath)).toBe(false);
  });

  it("breaks a lock path that cannot be read securely", async () => {
    const { layout, lockPath } = await makeLayout();
    const target = join(layout.state, "elsewhere.json");
    await writeFile(target, JSON.stringify({ pid: process.pid, token: "linked" }), { mode: 0o600 });
    await symlink(target, lockPath);
    await expect(withProviderCliLock(layout, "feishu", async () => "ran", { sleep: noSleep })).resolves.toBe("ran");
    expect(await exists(lockPath)).toBe(false);
    expect(await exists(target)).toBe(true);
  });

  it("only releases a lock it still owns", async () => {
    const { layout, lockPath } = await makeLayout();
    await withProviderCliLock(layout, "feishu", async () => {
      await rm(lockPath);
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "taken-over" }), { mode: 0o600 });
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({ pid: process.pid, token: "taken-over" });
  });

  it("leaves the lock path alone when the release read fails", async () => {
    const { layout, lockPath } = await makeLayout();
    const target = join(layout.state, "elsewhere.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await withProviderCliLock(layout, "feishu", async () => {
      await rm(lockPath);
      await symlink(target, lockPath);
    });
    expect(await exists(lockPath)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  it("serializes concurrent operations on the same provider", async () => {
    const { layout } = await makeLayout();
    let active = 0;
    let overlap = 0;
    const order: string[] = [];
    const run = (name: string) => async () => {
      active += 1;
      overlap = Math.max(overlap, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}:end`);
      active -= 1;
      return name;
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const results = await Promise.all([
      withProviderCliLock(layout, "feishu", run("first"), { sleep, retryDelayMs: 1 }),
      withProviderCliLock(layout, "feishu", run("second"), { sleep, retryDelayMs: 1 }),
    ]);
    expect(results.sort()).toEqual(["first", "second"]);
    expect(overlap).toBe(1);
    expect(order).toHaveLength(4);
  });

  it("keeps providers independent", async () => {
    const { layout } = await makeLayout();
    await writeFile(providerCliLockFilePath(layout, "slack"), JSON.stringify({ pid: process.pid, token: "x" }), {
      mode: 0o600,
    });
    await expect(withProviderCliLock(layout, "feishu", async () => "ran", { sleep: noSleep })).resolves.toBe("ran");
  });
});
