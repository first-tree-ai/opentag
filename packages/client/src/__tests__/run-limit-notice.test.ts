import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAgentRuntime } from "../agent-runtime/base-agent-runtime.js";
import { runLimitNotice, runLimitNoticeLeadMs, scheduleRunLimitNotice } from "../agent-runtime/run-limit-notice.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  type AgentPromptRequest,
  type AgentProviderRunContext,
  type AgentProviderRunResult,
} from "../agent-runtime/types.js";

const MINUTE = 60_000;
afterEach(() => vi.useRealTimers());

describe("the notice before a Run's limit", () => {
  it("leads by a tenth of what is left, at most five minutes, and skips a Run too short to act on it", () => {
    expect(runLimitNoticeLeadMs(120 * MINUTE)).toBe(5 * MINUTE);
    expect(runLimitNoticeLeadMs(30 * MINUTE)).toBe(3 * MINUTE);
    expect(runLimitNoticeLeadMs(10 * MINUTE)).toBe(MINUTE);
    expect(runLimitNoticeLeadMs(9 * MINUTE)).toBeUndefined();
    expect(runLimitNotice(5 * MINUTE)).toContain("in about 5 min");
  });

  it("does not schedule without a known limit, and survives a Provider that cannot take it", async () => {
    vi.useFakeTimers();
    const notify = vi.fn(async () => {
      throw new Error("closed");
    });
    expect(scheduleRunLimitNotice(undefined, notify)).toBeUndefined();
    expect(scheduleRunLimitNotice(MINUTE, notify)).toBeUndefined();
    scheduleRunLimitNotice(120 * MINUTE, notify);
    await vi.advanceTimersByTimeAsync(115 * MINUTE - 1);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledOnce();
  });

  class HoldingRuntime extends BaseAgentRuntime {
    finish: () => void = () => undefined;
    context?: AgentProviderRunContext;
    readonly told: string[] = [];
    constructor() {
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
      this.context = context;
      await new Promise<void>((resolve) => {
        this.finish = resolve;
      });
      return { status: "completed", output: [] };
    }
    protected override async tellProvider(text: string): Promise<void> {
      this.told.push(text);
    }
    protected async closeProvider(): Promise<void> {}
  }

  it("reaches the Provider during the Run, and not after it ended", async () => {
    vi.useFakeTimers();
    const runtime = new HoldingRuntime();
    const input = { items: [{ type: "text" as const, text: "go" }] };
    const first = runtime.prompt({ runId: "a", input, durationLimitInMs: 20 * MINUTE });
    await vi.advanceTimersByTimeAsync(18 * MINUTE);
    expect(runtime.told).toEqual([expect.stringContaining("in about 2 min")]);
    runtime.finish();
    await first;
    const second = runtime.prompt({ runId: "b", input, durationLimitInMs: 20 * MINUTE });
    await vi.advanceTimersByTimeAsync(MINUTE);
    runtime.finish();
    await second;
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(runtime.told).toHaveLength(1);
  });

  it("stands still while the Provider waits for a quota reset, and tells the caller", async () => {
    vi.useFakeTimers();
    const runtime = new HoldingRuntime();
    const waits: boolean[] = [];
    const run = runtime.prompt({
      runId: "a",
      input: { items: [{ type: "text", text: "go" }] },
      durationLimitInMs: 20 * MINUTE,
      onQuotaWaitChanged: (waiting) => waits.push(waiting),
    });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await runtime.context?.emit({ type: "quota_wait_changed", waiting: true });
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE);
    expect(runtime.told).toEqual([]);
    await runtime.context?.emit({ type: "quota_wait_changed", waiting: false });
    await vi.advanceTimersByTimeAsync(8 * MINUTE - 1);
    expect(runtime.told).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.told).toEqual([expect.stringContaining("in about 2 min")]);
    expect(waits).toEqual([true, false]);
    runtime.finish();
    await run;
  });
});
