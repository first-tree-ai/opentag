import { describe, expect, it } from "vitest";
import {
  AccountCloudComputerEnsureResponseSchema,
  AccountComputerSummarySchema,
  AccountSetupCompletionSchema,
  CompleteAccountSetupRequestSchema,
  ListAccountComputersResponseSchema,
} from "../index.js";

describe("Account contracts", () => {
  it("validates the explicit Account setup completion boundary", () => {
    const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
    expect(CompleteAccountSetupRequestSchema.parse({ agentId })).toEqual({ agentId });
    expect(() => CompleteAccountSetupRequestSchema.parse({ agentId, ready: true })).toThrow();
    expect(AccountSetupCompletionSchema.parse({ setupCompletedAt: "2026-08-20T00:00:00.000Z" })).toEqual({
      setupCompletedAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("requires explicit observation time for Computer connection snapshots", () => {
    expect(() => ListAccountComputersResponseSchema.parse({ computers: [{ id: crypto.randomUUID() }] })).toThrow();
  });

  it("parses old Local Computer summaries that omit kind without rewriting them", () => {
    const local = {
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      displayName: "workstation",
      platform: "linux" as const,
      connectionStatus: "online" as const,
      connectedAt: "2026-08-20T00:00:00.000Z",
      lastSeenAt: "2026-08-20T00:00:01.000Z",
      observedAt: "2026-08-20T00:00:02.000Z",
      createdAt: "2026-08-19T00:00:00.000Z",
      agentIds: ["1a63a21e-f6c7-4474-91ea-4dabf0566a24"],
    };
    expect(AccountComputerSummarySchema.parse(local)).toEqual(local);
    expect(AccountComputerSummarySchema.parse({ ...local, kind: "cloud" })).toEqual({ ...local, kind: "cloud" });
    expect(AccountComputerSummarySchema.parse({ ...local, kind: "local" })).toEqual({ ...local, kind: "local" });
  });

  it("requires Cloud Computer ensure to declare kind and logical online without execution proof", () => {
    const response = {
      computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
      kind: "cloud" as const,
      displayName: "Cloud",
      platform: "linux" as const,
      connectionStatus: "online" as const,
      createdAt: "2026-09-15T00:00:00.000Z",
    };
    expect(AccountCloudComputerEnsureResponseSchema.parse(response)).toEqual(response);
    expect(() => AccountCloudComputerEnsureResponseSchema.parse({ ...response, kind: "local" })).toThrow();
    expect(() =>
      AccountCloudComputerEnsureResponseSchema.parse({ ...response, connectionStatus: "offline" }),
    ).toThrow();
    expect(() =>
      AccountCloudComputerEnsureResponseSchema.parse({
        ...response,
        lastSeenAt: "2026-09-15T00:00:01.000Z",
      }),
    ).toThrow();
    expect(() =>
      AccountCloudComputerEnsureResponseSchema.parse({
        ...response,
        providerReadiness: [],
      }),
    ).toThrow();
    expect(() => AccountCloudComputerEnsureResponseSchema.parse({ ...response, executionReady: true })).toThrow();
    expect(() => {
      const { kind: _kind, ...legacy } = response;
      AccountCloudComputerEnsureResponseSchema.parse(legacy);
    }).toThrow();
  });
});
