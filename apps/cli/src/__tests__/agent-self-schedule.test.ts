import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSchedule } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import {
  runAgentSelfScheduleCreate,
  runAgentSelfScheduleDelete,
  runAgentSelfSchedulePause,
  runAgentSelfSchedulePreview,
  runAgentSelfScheduleUpdate,
  type ScheduleSelfApiClient,
} from "../core/agent/self-schedule.js";

const id = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const now = "2026-09-28T00:00:00.000Z";
const schedule: AgentSchedule = {
  id,
  agentId: id,
  name: "Daily report",
  prompt: "report\n",
  target: {
    sessionId: id,
    provider: "feishu",
    sessionKind: "channel",
    channelId: "oc-test",
    threadKey: null,
  },
  schedule: { kind: "every", intervalSeconds: 120, anchorAt: now },
  timezone: "Asia/Taipei",
  enabled: true,
  nextTriggerAt: "2026-09-28T00:02:00.000Z",
  revision: 3,
  lastDispatch: null,
  detailUrl: `https://example.test/agents/${id}?schedule=${id}`,
  createdAt: now,
  updatedAt: now,
};

function fakeApi() {
  const api = {
    createRuntimeAgentSchedule: vi.fn(async () => schedule),
    listRuntimeAgentSchedules: vi.fn(async () => ({ items: [], nextCursor: null })),
    getRuntimeAgentSchedule: vi.fn(async () => schedule),
    updateRuntimeAgentSchedule: vi.fn(async () => ({ ...schedule, revision: 4 })),
    pauseRuntimeAgentSchedule: vi.fn(async () => ({ ...schedule, enabled: false, revision: 4 })),
    resumeRuntimeAgentSchedule: vi.fn(async () => ({ ...schedule, revision: 4 })),
    deleteRuntimeAgentSchedule: vi.fn(async () => undefined),
    previewRuntimeAgentSchedule: vi.fn(async () => ({
      calculatedAt: now,
      schedule: schedule.schedule,
      timezone: schedule.timezone,
      items: [],
    })),
  } satisfies ScheduleSelfApiClient;
  return { api, deps: { api, proof: "fixture-proof" } };
}

describe("agent self schedule", () => {
  it("requires a managed Session before making a request", async () => {
    const environment = {} as NodeJS.ProcessEnv;
    await expect(runAgentSelfSchedulePause(id, { environment })).rejects.toMatchObject({
      code: "AGENT_SELF_SESSION_REQUIRED",
    });
  });

  it("preserves prompt-file bytes and sends exactly one create request", async () => {
    const { api, deps } = fakeApi();
    const directory = await mkdtemp(join(tmpdir(), "opentag-schedule-"));
    try {
      const file = join(directory, "prompt.md");
      await writeFile(file, "Line one\n\nLast line\n", "utf8");
      await runAgentSelfScheduleCreate({
        ...deps,
        name: "Daily report",
        promptFile: file,
        every: "120",
        timezone: "Asia/Taipei",
      });
      expect(api.createRuntimeAgentSchedule).toHaveBeenCalledExactlyOnceWith("fixture-proof", {
        name: "Daily report",
        prompt: "Line one\n\nLast line\n",
        schedule: { kind: "every", intervalSeconds: 120 },
        timezone: "Asia/Taipei",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads current revision for changes and leaves conflicts to the caller", async () => {
    const { api, deps } = fakeApi();
    await runAgentSelfScheduleUpdate(id, { ...deps, name: "Renamed" });
    expect(api.updateRuntimeAgentSchedule).toHaveBeenCalledWith("fixture-proof", id, {
      expectedRevision: 3,
      name: "Renamed",
    });
    await runAgentSelfSchedulePause(id, deps);
    expect(api.pauseRuntimeAgentSchedule).toHaveBeenCalledWith("fixture-proof", id, 3);
    await runAgentSelfScheduleDelete(id, deps);
    expect(api.deleteRuntimeAgentSchedule).toHaveBeenCalledWith("fixture-proof", id, 3);
    api.updateRuntimeAgentSchedule.mockRejectedValueOnce(new Error("SCHEDULE_REVISION_CONFLICT"));
    await expect(runAgentSelfScheduleUpdate(id, { ...deps, name: "Again" })).rejects.toThrow(
      "SCHEDULE_REVISION_CONFLICT",
    );
    expect(api.updateRuntimeAgentSchedule).toHaveBeenCalledTimes(2);
  });

  it("rejects unowned rule fields and chooses stored or ad-hoc preview", async () => {
    const { api, deps } = fakeApi();
    await expect(
      runAgentSelfScheduleCreate({ ...deps, name: "A", prompt: "x", every: "59", timezone: "UTC" }),
    ).rejects.toThrow();
    expect(api.createRuntimeAgentSchedule).not.toHaveBeenCalled();
    await runAgentSelfSchedulePreview({ ...deps, scheduleId: id });
    await runAgentSelfSchedulePreview({ ...deps, cron: "0 9 * * *", timezone: "Asia/Taipei" });
    expect(api.previewRuntimeAgentSchedule).toHaveBeenNthCalledWith(1, "fixture-proof", { scheduleId: id });
    expect(api.previewRuntimeAgentSchedule).toHaveBeenNthCalledWith(2, "fixture-proof", {
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "Asia/Taipei",
    });
  });

  it("registers the complete CLI surface without target or run-now options", () => {
    const program = createProgram();
    const agent = program.commands.find((command) => command.name() === "agent");
    const self = agent?.commands.find((command) => command.name() === "self");
    const command = self?.commands.find((entry) => entry.name() === "schedule");
    expect(command?.commands.map((entry) => entry.name())).toEqual([
      "create",
      "list",
      "show",
      "update",
      "pause",
      "resume",
      "delete",
      "preview",
    ]);
    const flags = command?.commands.flatMap((entry) => entry.options.map((option) => option.long));
    expect(flags).not.toContain("--target");
    expect(flags).not.toContain("--run-now");
    expect(command?.commands.every((entry) => entry.options.some((option) => option.long === "--json"))).toBe(true);
  });
});
