import { TaskStatusSchema } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { TASK_STATUS_GROUPS, taskStatusGroup, taskStatusGroupLabel, taskStatusGroupTone } from "./task-status.js";

describe("Task status groups", () => {
  it("reads every Server status as one of four states", () => {
    expect(Object.fromEntries(TaskStatusSchema.options.map((status) => [status, taskStatusGroup(status)]))).toEqual({
      queued: "queued",
      running: "running",
      completed: "completed",
      failed: "failed",
      cancelled: "completed",
      expired: "failed",
      ended: "completed",
      idle: "completed",
    });
  });

  it("labels and tones each state", () => {
    expect(TASK_STATUS_GROUPS.map((group) => [taskStatusGroupLabel(group), taskStatusGroupTone(group)])).toEqual([
      ["Queued", "info"],
      ["Running", "info"],
      ["Completed", "success"],
      ["Failed", "danger"],
    ]);
  });
});
