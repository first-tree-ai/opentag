import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { NativeSandbox } from "../runner/native-sandbox.js";

function capturedProcess(source: string) {
  return new NativeSandbox({
    name: "capture-test",
    workspace: "/tmp/capture-test",
    spawnProcess: () => spawn(process.execPath, ["-e", source], { stdio: "pipe" }),
  });
}

describe("native supervisor output capture", () => {
  it("preserves UTF-8 characters split between process output chunks", async () => {
    const sandbox = capturedProcess(`
      const bytes=Buffer.from('任务🙂');
      process.stdout.write(bytes.subarray(0, 1));
      process.stderr.write(bytes.subarray(0, 2));
      setTimeout(()=>{
        process.stdout.end(bytes.subarray(1));
        process.stderr.end(bytes.subarray(2));
      }, 100);
    `);
    const output = await sandbox.exec("node", [], { timeoutMs: 5_000 });
    expect(output).toEqual({ code: 0, stdout: "任务🙂", stderr: "任务🙂" });
  });

  it("caps both streams by bytes while still draining an oversized child", async () => {
    const sandbox = capturedProcess(`
      process.stdout.write('🙂'.repeat(256 * 1024));
      process.stderr.write('🙂'.repeat(256 * 1024));
    `);
    const output = await sandbox.exec("node", [], { timeoutMs: 5_000 });
    expect(output.code).toBe(0);
    expect(Buffer.byteLength(output.stdout)).toBe(256 * 1024);
    expect(Buffer.byteLength(output.stderr)).toBe(256 * 1024);
    expect(output.stdout).not.toContain("�");
  });
});
