import { describe, expect, it } from "vitest";
import { assertAgentSessionsStopped } from "../runtime/agent-session-stopper.js";

describe("stopAgentSessions", () => {
  it("accepts only explicit stopped reconciliation results", () => {
    expect(() =>
      assertAgentSessionsStopped([
        {
          status: "fulfilled",
          value: {
            type: "session:reconcile:result",
            requestId: "request-1",
            sessionId: "session-1",
            placementGeneration: 1,
            status: "stopped",
          },
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAgentSessionsStopped([
        {
          status: "fulfilled",
          value: {
            type: "session:reconcile:result",
            requestId: "request-2",
            sessionId: "session-1",
            placementGeneration: 1,
            status: "rejected",
            reason: "runtime unavailable",
          },
        },
      ]),
    ).toThrow("Agent runtime stop notification failed");
    expect(() => assertAgentSessionsStopped([{ status: "rejected", reason: new Error("connection closed") }])).toThrow(
      "Agent runtime stop notification failed",
    );
  });
});
