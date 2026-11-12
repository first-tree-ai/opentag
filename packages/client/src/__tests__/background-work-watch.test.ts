import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundWorkWatch } from "../agent-runtime/background-work-watch.js";
import { BaseAgentRuntime } from "../agent-runtime/base-agent-runtime.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  type AgentPromptRequest,
  type AgentProviderRunContext,
  type AgentProviderRunResult,
  type AgentRuntimeEvent,
} from "../agent-runtime/types.js";

const MINUTE = 60_000;
afterEach(() => vi.useRealTimers());

const changed = (...items: { id: string; label: string; outputPath?: string; reportsProgress?: boolean }[]) =>
  ({ type: "background_work_changed", runId: "run", items }) as AgentRuntimeEvent;

function watch(marks: Record<string, string | undefined> = {}) {
  let now = 0;
  const notices: string[] = [];
  const instance = new BackgroundWorkWatch({
    notify: async (text) => {
      notices.push(text);
    },
    now: () => now,
    outputMark: async (path) => marks[path],
  });
  return {
    instance,
    notices,
    marks,
    at: async (minutes: number) => {
      now = minutes * MINUTE;
      await instance.check();
    },
  };
}

describe("BackgroundWorkWatch", () => {
  it("tells once work has been quiet for ten minutes, naming what it knows, and backs off", async () => {
    const { instance, notices, marks, at } = watch({ "/a.log": "1" });
    instance.observe(changed({ id: "a", label: "suite", outputPath: "/a.log" }));
    await at(0);
    await at(9);
    expect(notices).toEqual([]);
    await at(10);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("- suite (running for 10 min, no output for 10 min; output: /a.log)");
    expect(notices[0]).toContain("openTag cannot tell");
    await at(29);
    expect(notices).toHaveLength(1);
    await at(30);
    expect(notices).toHaveLength(2);
    await at(59);
    expect(notices).toHaveLength(2);
    await at(60);
    expect(notices).toHaveLength(3);
    await at(119);
    expect(notices).toHaveLength(3);
    await at(120);
    expect(notices).toHaveLength(4);
    expect(marks).toBeDefined();
    instance.stop();
  });

  it("starts over once the output changes", async () => {
    const { instance, notices, marks, at } = watch({ "/a.log": "1" });
    instance.observe(changed({ id: "a", label: "suite", outputPath: "/a.log" }));
    await at(0);
    await at(10);
    expect(notices).toHaveLength(1);
    marks["/a.log"] = "2";
    await at(12);
    await at(21);
    expect(notices).toHaveLength(1);
    await at(22);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("running for 22 min, no output for 10 min");
    instance.stop();
  });

  it("counts Provider-reported output as progress, for work without a file", async () => {
    const { instance, notices, at } = watch();
    instance.observe(changed({ id: "a", label: "suite", reportsProgress: true }));
    await at(5);
    instance.progress("a");
    instance.progress("unknown");
    await at(14);
    expect(notices).toEqual([]);
    await at(15);
    expect(notices[0]).not.toContain("output:");
    instance.stop();
  });

  it("does not watch work it cannot see, such as a timer", async () => {
    const { instance, notices, at } = watch();
    instance.observe(changed({ id: "wake", label: "ScheduleWakeup timer" }));
    await at(600);
    expect(notices).toEqual([]);
  });

  it("forgets work that left the list, and learns an output path that appears later", async () => {
    const { instance, notices, marks, at } = watch();
    instance.observe(
      changed({ id: "a", label: "a", reportsProgress: true }, { id: "b", label: "b", outputPath: "/b" }),
    );
    instance.observe(changed({ id: "b", label: "renamed", outputPath: "/b2" }));
    marks["/b2"] = "1";
    await at(10);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("- renamed");
    expect(notices[0]).not.toContain("- a ");
    instance.observe(changed({ id: "b", label: "renamed" }));
    instance.observe(changed());
    await at(600);
    expect(notices).toHaveLength(1);
  });

  it("checks on a timer while work is live, and stops when none is", async () => {
    vi.useFakeTimers();
    const notify = vi.fn(async () => undefined);
    const instance = new BackgroundWorkWatch({ notify, outputMark: async () => "same" });
    instance.observe({ type: "run_started", runId: "run" });
    instance.observe(changed({ id: "a", label: "suite", outputPath: "/a" }));
    instance.observe(changed({ id: "a", label: "suite", outputPath: "/a" }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 30_000);
    expect(notify).toHaveBeenCalledOnce();
    notify.mockRejectedValueOnce(new Error("closed") as never);
    await vi.advanceTimersByTimeAsync(20 * MINUTE + 30_000);
    expect(notify).toHaveBeenCalledTimes(2);
    instance.observe(changed());
    await vi.advanceTimersByTimeAsync(600 * MINUTE);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("reads a real file's size and modification time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "background-watch-"));
    try {
      const path = join(directory, "out.log");
      writeFileSync(path, "x");
      let now = 0;
      const notices: string[] = [];
      const instance = new BackgroundWorkWatch({
        notify: async (text) => {
          notices.push(text);
        },
        now: () => now,
      });
      instance.observe(
        changed(
          { id: "a", label: "a", outputPath: path },
          { id: "b", label: "b", outputPath: join(directory, "none") },
        ),
      );
      await instance.check();
      writeFileSync(path, "xx");
      now = 9 * MINUTE;
      await instance.check();
      now = 10 * MINUTE;
      await instance.check();
      expect(notices[0]).toContain("- b");
      expect(notices[0]).not.toContain("- a");
      instance.stop();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("a Run's quiet background work", () => {
  class HoldingRuntime extends BaseAgentRuntime {
    finish: () => void = () => undefined;
    readonly told: string[] = [];
    constructor(readonly listens: boolean) {
      super({
        manifest: {
          providerId: "test",
          displayName: "Test",
          contractVersion: AGENT_RUNTIME_CONTRACT_VERSION,
          bindingSchemaVersion: 1,
        },
        capabilities: {} as never,
        eventSink: async () => undefined,
      });
    }
    protected async executeRun(
      _request: AgentPromptRequest,
      context: AgentProviderRunContext,
    ): Promise<AgentProviderRunResult> {
      await context.emit({
        type: "background_work_changed",
        items: [{ id: "a", label: "suite", reportsProgress: true }],
      });
      await new Promise<void>((resolve) => {
        this.finish = resolve;
      });
      return { status: "completed", output: [] };
    }
    protected override tellProviderAboutBackgroundWork(text: string): Promise<void> {
      if (!this.listens) return super.tellProviderAboutBackgroundWork(text);
      this.told.push(text);
      return Promise.resolve();
    }
    protected async closeProvider(): Promise<void> {}
  }

  it("goes to the Provider while the Run waits, and stops with the Run", async () => {
    vi.useFakeTimers();
    const runtime = new HoldingRuntime(true);
    const run = runtime.prompt({ runId: "r", input: { items: [{ type: "text", text: "go" }] } });
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 30_000);
    expect(runtime.told).toHaveLength(1);
    expect(runtime.told[0]).toContain("- suite");
    runtime.finish();
    await run;
    await vi.advanceTimersByTimeAsync(600 * MINUTE);
    expect(runtime.told).toHaveLength(1);
  });

  it("is dropped by a Provider that has no way to pass it on", async () => {
    vi.useFakeTimers();
    const runtime = new HoldingRuntime(false);
    const run = runtime.prompt({ runId: "r", input: { items: [{ type: "text", text: "go" }] } });
    await vi.advanceTimersByTimeAsync(10 * MINUTE + 30_000);
    runtime.finish();
    await expect(run).resolves.toMatchObject({ status: "completed" });
  });
});
