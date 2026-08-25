import { describe, expect, it } from "vitest";
import { ComputerConnectCodeExchangeResponseSchema, ComputerProviderReadinessCollectionSchema } from "../computer.js";

describe("computer contracts", () => {
  it("returns enrollment-scoped machine authority", () => {
    const response = {
      workspaceComputerId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      machineToken: "opaque-secret",
    };
    expect(ComputerConnectCodeExchangeResponseSchema.parse(response)).toEqual(response);
    expect(() => ComputerConnectCodeExchangeResponseSchema.parse({ ...response, accessToken: "human" })).toThrow();
  });

  it("keeps provider readiness canonical", () => {
    expect(() =>
      ComputerProviderReadinessCollectionSchema.parse([
        { provider: "claude-code", status: "ready", observedAt: null },
        { provider: "codex", status: "ready", observedAt: null },
      ]),
    ).toThrow();
  });
});
