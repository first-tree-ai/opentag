import { describe, expect, it } from "vitest";
import { closeServerResources, startClosingServerResources } from "../shutdown.js";
import { deferred } from "./support/deferred.js";

describe("server resource shutdown", () => {
  it("initiates every stop before joining work that needs another resource to close", async () => {
    const peerClosed = deferred();
    const first = new Error("synchronous stop");
    const second = new Error("asynchronous stop");
    const started: string[] = [];
    const result = startClosingServerResources([
      [
        "waiting owner",
        async () => {
          started.push("owner");
          await peerClosed.promise;
        },
      ],
      [
        "failed stop",
        () => {
          started.push("sync failure");
          throw first;
        },
      ],
      [
        "peer",
        () => {
          started.push("peer");
          peerClosed.resolve();
        },
      ],
      [
        "failed join",
        async () => {
          started.push("async failure");
          throw second;
        },
      ],
    ]).catch((error: AggregateError) => error);
    expect(started).toEqual(["owner", "sync failure", "peer", "async failure"]);
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((failure: Error) => failure.cause)).toEqual([first, second]);
  });
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
