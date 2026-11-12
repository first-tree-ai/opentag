import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundWorkExtension, {
  BACKGROUND_WORK_STATUS_KEY,
  type BackgroundWorkStatus,
} from "../pi-extensions/background-work.js";
import { PI_BACKGROUND_WORK_STATUS_KEY } from "../providers/pi/agent-runtime.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
  vi.restoreAllMocks();
});

function load() {
  let tool: Parameters<Parameters<typeof backgroundWorkExtension>[0]["registerTool"]>[0] | undefined;
  let shutdown: () => void = () => undefined;
  const sent: { content: string; options: unknown }[] = [];
  const statuses: BackgroundWorkStatus[] = [];
  backgroundWorkExtension({
    registerTool: (definition) => {
      tool = definition;
    },
    on: (_event, handler) => {
      shutdown = handler;
    },
    sendMessage: (message, options) => sent.push({ content: message.content, options }),
  });
  const cwd = mkdtempSync(join(tmpdir(), "background-extension-"));
  directories.push(cwd);
  const ctx = {
    cwd,
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        expect(key).toBe(BACKGROUND_WORK_STATUS_KEY);
        statuses.push(JSON.parse(text as string));
      },
    },
  };
  const start = (toolCallId: string, command: string, description?: string) =>
    (tool as NonNullable<typeof tool>).execute(toolCallId, { command, description }, undefined, undefined, ctx);
  return { start, sent, statuses, shutdown: () => shutdown() };
}

describe("background work extension", () => {
  it("reports under the key the runtime reads", () => {
    expect(BACKGROUND_WORK_STATUS_KEY).toBe(PI_BACKGROUND_WORK_STATUS_KEY);
  });

  it("returns at once, reports the work live, and wakes the model with the result when it ends", async () => {
    const { start, sent, statuses } = load();
    const result = await start("call/1", "echo BG-OUT; exit 0", "marker job");
    expect(result.content[0]?.text).toContain("Started in the background");
    expect(statuses[0]?.live).toEqual([expect.objectContaining({ id: "call/1", label: "marker job" })]);
    expect(statuses[0]?.live[0]?.outputPath).toMatch(/call_1\.log$/);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(sent[0]?.content).toContain("marker job (exit code 0)");
    expect(sent[0]?.content).toContain("BG-OUT");
    expect(statuses.at(-1)).toMatchObject({
      live: [],
      finished: { id: "call/1", status: "completed", detail: "exit code 0" },
    });
  });

  it("reports a failure and a command with no output, naming it by the command when undescribed", async () => {
    const { start, sent, statuses } = load();
    await start("two", "exit 3");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.content).toContain("exit 3 (exit code 3)");
    expect(sent[0]?.content).toContain("It produced no output.");
    expect(statuses.at(-1)?.finished?.status).toBe("failed");
  });

  it("names the signal when something else kills the work, and only the tail of long output", async () => {
    const { start, sent } = load();
    await start("three", "head -c 6000 /dev/zero | tr '\\0' x; kill -KILL $$");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.content).toContain("killed by SIGKILL");
    expect(sent[0]?.content.length).toBeLessThan(4_400);
  });

  it("does not wake the model for work the Run is stopping", async () => {
    const { start, sent, statuses, shutdown } = load();
    await start("four", "sleep 30");
    shutdown();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toEqual([]);
    expect(statuses).toHaveLength(1);
  });

  it("stops waking once the process itself is told to stop", async () => {
    const once = vi.spyOn(process, "once");
    const { start, sent } = load();
    const handler = once.mock.calls.find(([event]) => event === "SIGTERM")?.[1] as () => void;
    await start("five", "sleep 0.1");
    handler();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toEqual([]);
  });
});
