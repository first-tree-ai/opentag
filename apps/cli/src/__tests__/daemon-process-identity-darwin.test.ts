import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: childProcessMocks.execFile,
}));

import { inspectDarwinProcessIdentity, inspectProcessIdentity } from "../core/daemon/process-lease.js";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function psInvocations(): Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> {
  return childProcessMocks.execFile.mock.calls.map((call) => ({
    file: String(call[0]),
    args: [...(call[1] as string[])],
    env: (call[2] as { env: NodeJS.ProcessEnv }).env,
  }));
}

describe("darwin process identity via ps", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("identifies a process by its ps start time under a C locale", async () => {
    childProcessMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, "Mon Jan  1 00:00:00 2024\n", "");
      },
    );
    await expect(inspectDarwinProcessIdentity(4242)).resolves.toEqual({
      id: "darwin:Mon Jan  1 00:00:00 2024",
      state: "identified",
    });
    const [invocation] = psInvocations();
    expect(invocation).toMatchObject({ file: "ps", args: ["-o", "lstart=", "-p", "4242"] });
    expect(invocation?.env).toMatchObject({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
  });

  it("treats a failed ps lookup of a dead process as gone and of a live one as unverifiable", async () => {
    childProcessMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(new Error("ps exited with code 1"), "", "");
      },
    );
    await expect(inspectDarwinProcessIdentity(4242, { isProcessAlive: () => false })).resolves.toEqual({
      state: "gone",
    });
    await expect(inspectDarwinProcessIdentity(4242, { isProcessAlive: () => true })).resolves.toEqual({
      state: "unverifiable",
    });
  });

  it("treats empty ps output as no start time", async () => {
    childProcessMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, "   \n", "");
      },
    );
    await expect(inspectDarwinProcessIdentity(4242, { isProcessAlive: () => false })).resolves.toEqual({
      state: "gone",
    });
  });

  it("uses the ps-backed inspector by default on darwin", async () => {
    childProcessMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, "Tue Jan  2 00:00:00 2024\n", "");
      },
    );
    await expect(inspectProcessIdentity(4242, { platform: "darwin", isProcessAlive: () => true })).resolves.toEqual({
      id: "darwin:Tue Jan  2 00:00:00 2024",
      state: "identified",
    });
  });
});
