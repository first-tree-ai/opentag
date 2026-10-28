import { describe, expect, it } from "vitest";
import { closeServerResources } from "../shutdown.js";

describe("server resource shutdown", () => {
  it("closes the database and telemetry after synchronous and asynchronous worker failures", async () => {
    const closed: string[] = [];
    const first = new Error("Database transport failed");
    const second = new Error("Worker stop failed");
    let error: AggregateError | undefined;
    try {
      await closeServerResources([
        [
          "scheduler",
          () => {
            closed.push("scheduler");
            throw first;
          },
        ],
        [
          "runtime",
          async () => {
            closed.push("runtime");
            throw second;
          },
        ],
        [
          "database",
          async () => {
            await Promise.resolve();
            closed.push("database");
          },
        ],
        [
          "telemetry",
          () => {
            closed.push("telemetry");
          },
        ],
      ]);
    } catch (cause) {
      error = cause as AggregateError;
    }
    expect(closed).toEqual(["scheduler", "runtime", "database", "telemetry"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.errors.map((failure: Error) => failure.cause)).toEqual([first, second]);
    expect(error?.errors.map((failure: Error) => failure.message)).toEqual([
      "Failed to close scheduler",
      "Failed to close runtime",
    ]);
  });
});
