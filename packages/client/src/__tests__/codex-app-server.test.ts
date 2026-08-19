import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerError, CodexAppServerProcess } from "../providers/codex/app-server-wire.js";

const fixture = fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexAppServerProcess", () => {
  it("D-01 exchanges strict stdio JSONL and initializes before requests", async () => {
    const process = await appServer("normal");
    const initialized = notification(process, "fixture/initialized");
    await process.initialize("0.0.1");
    await initialized;
    await expect(process.request("fixture/echo", { value: "ok" })).resolves.toEqual({ value: "ok" });
    await process.close();
  });

  it("D-01/D-25 rejects an App Server that initializes with another Codex Home", async () => {
    const process = await appServer("wrong-home", undefined, "/expected/codex-home");
    await expect(process.initialize("0.0.1")).rejects.toMatchObject({ code: "protocol" });
    await process.close();
  });

  it.each(["malformed", "oversized", "truncated"])("D-06 fails closed for %s output", async (scenario) => {
    const process = await appServer(scenario, 1024);
    const failure = processFailure(process);
    await process.initialize("0.0.1").catch(() => undefined);
    await expect(failure).resolves.toBeInstanceOf(CodexAppServerError);
    await expect(process.request("fixture/echo", {})).rejects.toBeInstanceOf(CodexAppServerError);
    await process.close().catch(() => undefined);
  });

  it("D-04 cancels unattended approvals without exposing an approval channel", async () => {
    const process = await appServer("normal");
    await process.initialize("0.0.1");
    await expect(process.request("fixture/approval", {})).resolves.toEqual({ decision: "cancel" });
    await process.close();
  });

  it("D-06 rejects unknown server requests", async () => {
    const process = await appServer("normal");
    await process.initialize("0.0.1");
    const failure = processFailure(process);
    await process.request("fixture/unknown-request", {}).catch(() => undefined);
    await expect(failure).resolves.toMatchObject({ code: "protocol" });
    await process.close();
  });

  it("hosts a bounded dynamic tool call inside the daemon process", async () => {
    const process = await appServer("normal");
    process.setDynamicToolHandler(async (call) => ({
      success: call.tool === "opentag_message_send" && (call.arguments as { text?: string }).text === "hello",
      text: JSON.stringify({ state: "succeeded" }),
    }));
    await process.initialize("0.0.1");
    await expect(process.request("fixture/hosted-tool", {})).resolves.toEqual({
      contentItems: [{ type: "inputText", text: JSON.stringify({ state: "succeeded" }) }],
      success: true,
    });
    await process.close();
  });

  it("D-11 closes the watched provider process group including descendants", async () => {
    const process = await appServer("process-tree");
    const descendant = new Promise<number>((resolve) => {
      const unsubscribe = process.subscribe((message) => {
        if (message.method !== "fixture/processTree") return;
        const pid = (message.params as { pid?: unknown }).pid;
        if (typeof pid !== "number") return;
        unsubscribe();
        resolve(pid);
      });
    });
    await process.initialize("0.0.1");
    const pid = await descendant;
    await process.close();
    await vi.waitFor(() => expect(processExists(pid)).toBe(false));
  });

  it("D-11 tears down descendants when the direct provider exits unexpectedly", async () => {
    const process = await appServer("process-tree-exit");
    const descendant = new Promise<number>((resolve) => {
      const unsubscribe = process.subscribe((message) => {
        if (message.method !== "fixture/processTree") return;
        const pid = (message.params as { pid?: unknown }).pid;
        if (typeof pid !== "number") return;
        unsubscribe();
        resolve(pid);
      });
    });
    const failure = processFailure(process);
    await process.initialize("0.0.1");
    const pid = await descendant;
    await expect(failure).resolves.toBeInstanceOf(CodexAppServerError);
    await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 3_000 });
    await process.close().catch(() => undefined);
  });
});

async function appServer(
  scenario: string,
  maxLineBytes?: number,
  expectedCodexHome?: string,
): Promise<CodexAppServerProcess> {
  const cwd = await mkdtemp(join(tmpdir(), "opentag-codex-wire-"));
  directories.push(cwd);
  return new CodexAppServerProcess({
    command: process.execPath,
    args: [fixture],
    cwd,
    env: {
      PATH: process.env.PATH,
      CODEX_FIXTURE_SCENARIO: scenario,
      ...(scenario === "wrong-home" ? { CODEX_FIXTURE_HOME: "/different/codex-home" } : {}),
    },
    expectedCodexHome,
    maxLineBytes,
    requestTimeoutMs: 2_000,
  });
}

function notification(process: CodexAppServerProcess, method: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = process.subscribe((message) => {
      if (message.method !== method) return;
      unsubscribe();
      resolve();
    });
  });
}

function processFailure(process: CodexAppServerProcess): Promise<Error> {
  return new Promise((resolve) => {
    const unsubscribe = process.subscribe((message) => {
      if (message.method !== "opentag/processError") return;
      const params = message.params as { error?: unknown };
      if (!(params.error instanceof Error)) return;
      unsubscribe();
      resolve(params.error);
    });
  });
}

function processExists(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
