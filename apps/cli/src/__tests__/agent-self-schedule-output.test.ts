import type { AgentSchedule } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_SCHEDULE_PRESENTATION } from "../core/agent/self-schedule.js";
import { presentCommand } from "../core/command/policy.js";

const id = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const now = "2026-09-28T00:00:00.000Z";
const prompt = "plain test prompt\n\nCall it with password=hunter2 and Bearer abc123\n";
const schedule: AgentSchedule = {
  id,
  agentId: id,
  name: "Daily report",
  prompt,
  target: {
    sessionId: id,
    provider: "feishu",
    sessionKind: "channel",
    channelId: "oc-test",
    threadKey: null,
  },
  schedule: { kind: "every", intervalSeconds: 120, anchorAt: now },
  timezone: "UTC",
  enabled: true,
  nextTriggerAt: now,
  revision: 3,
  lastDispatch: null,
  detailUrl: "https://example.test/schedule",
  createdAt: now,
  updatedAt: now,
};

const coreMocks = vi.hoisted(() => ({
  result: undefined as unknown,
}));

vi.mock("../core/agent/self-schedule.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../core/agent/self-schedule.js")>();
  const answer = async () => coreMocks.result;
  return {
    ...original,
    runAgentSelfScheduleCreate: answer,
    runAgentSelfScheduleShow: answer,
    runAgentSelfScheduleUpdate: answer,
    runAgentSelfSchedulePause: answer,
    runAgentSelfScheduleResume: answer,
  };
});

function present(value: AgentSchedule, json: boolean): string {
  const stdout: string[] = [];
  presentCommand(
    { ok: true, value, exitCode: 0 },
    { json, stdout: (chunk) => stdout.push(chunk), ...FULL_SCHEDULE_PRESENTATION },
  );
  return stdout.join("");
}

describe("full Schedule output", () => {
  it("prints the stored prompt verbatim as JSON, so it can be written back", () => {
    expect(JSON.parse(present(schedule, true)).result.prompt).toBe(prompt);
  });

  it("prints the stored prompt verbatim for people", () => {
    expect(present(schedule, false)).toContain(`Prompt:\n${prompt}`);
  });

  it("keeps redacting every other field", () => {
    const { result } = JSON.parse(present({ ...schedule, name: "password=hunter2" }, true));
    expect(result.name).toBe("password=[REDACTED]");
    expect(result.prompt).toBe(prompt);
  });
});

describe("self schedule commands", () => {
  const originalExitCode = process.exitCode;
  let written: string[];

  beforeEach(() => {
    written = [];
    coreMocks.result = schedule;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it.each([
    ["create", ["--name", "n", "--timezone", "UTC", "--every", "120", "--prompt", "x"]],
    ["show", [id]],
    ["update", [id, "--prompt", "x"]],
    ["pause", [id]],
    ["resume", [id]],
  ])("%s returns the real prompt", async (command, args) => {
    const { createProgram } = await import("../cli/program.js");
    await createProgram().parseAsync(["node", "opentag", "agent", "self", "schedule", command, ...args, "--json"]);
    expect(JSON.parse(written.join("")).result.prompt).toBe(prompt);
  });
});
