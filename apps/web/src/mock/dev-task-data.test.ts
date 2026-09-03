import { ListTasksResponseSchema, TaskDetailSchema } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { createDevelopmentTaskDetail, createDevelopmentTasks, isDevelopmentTaskId } from "./dev-task-data.js";

const agentId = "40000000-0000-4000-8000-000000000001";

describe("development Task examples", () => {
  it("creates a varied list that satisfies the public Task schema", () => {
    const response = createDevelopmentTasks(agentId);

    expect(ListTasksResponseSchema.safeParse(response).success).toBe(true);
    expect(new Set(response.tasks.map((task) => task.status)).size).toBeGreaterThan(3);
    expect(response.tasks.every((task) => isDevelopmentTaskId(task.id))).toBe(true);
  });

  it("creates a schema-valid detail view for every example", () => {
    const response = createDevelopmentTasks(agentId);

    for (const task of response.tasks) {
      const detail = createDevelopmentTaskDetail(task.id, agentId);
      expect(detail).toBeDefined();
      expect(TaskDetailSchema.safeParse(detail).success).toBe(true);
    }
  });
});
