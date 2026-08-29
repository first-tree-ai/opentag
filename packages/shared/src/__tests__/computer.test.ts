import { describe, expect, it } from "vitest";
import {
  AccountComputerConnectCodeIssueRequestSchema,
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  ComputerConnectCodeIssueResponseSchema,
  ComputerProviderReadinessCollectionSchema,
} from "../computer.js";

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

  it("treats an empty Account connect-code request as create and requires an explicit repair target", () => {
    expect(AccountComputerConnectCodeIssueRequestSchema.parse({})).toEqual({});
    expect(AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "create" })).toEqual({ mode: "create" });
    const targetComputerId = crypto.randomUUID();
    expect(AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "repair", targetComputerId })).toEqual({
      mode: "repair",
      targetComputerId,
    });
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "repair" })).toThrow();
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ mode: "create", targetComputerId })).toThrow();
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ workspaceId: crypto.randomUUID() })).toThrow();
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ accountId: crypto.randomUUID() })).toThrow();
  });

  it("keeps exchange as an installation report rather than a Computer identity hint", () => {
    const request = {
      code: "otcc_abcdefghijklmnopqrstuvwx",
      computerId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux" as const,
      arch: "x64",
      clientVersion: "0.0.1",
    };
    expect(ComputerConnectCodeExchangeRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      ComputerConnectCodeExchangeRequestSchema.parse({ ...request, targetComputerId: crypto.randomUUID() }),
    ).toThrow();
    expect(() => ComputerConnectCodeExchangeRequestSchema.parse({ ...request, mode: "repair" })).toThrow();
  });

  it("accepts optional create and repair mode on the issue response", () => {
    const response = {
      bootstrapCommand: "opentag computer connect --server https://opentag.example -- otcc_code",
      expiresIn: 900,
      issuedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(ComputerConnectCodeIssueResponseSchema.parse(response)).toEqual(response);
    expect(ComputerConnectCodeIssueResponseSchema.parse({ ...response, mode: "repair" })).toEqual({
      ...response,
      mode: "repair",
    });
    expect(() => ComputerConnectCodeIssueResponseSchema.parse({ ...response, mode: "merge" })).toThrow();
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
