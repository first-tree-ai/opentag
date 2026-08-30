import { describe, expect, it } from "vitest";
import {
  AccountComputerConnectCodeIssueRequestSchema,
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  ComputerConnectCodeIssueResponseSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerProviderReadinessCollectionSchema,
} from "../computer.js";

describe("computer contracts", () => {
  it("returns strict Computer-scoped machine authority", () => {
    const response = {
      computerId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
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
    expect(() => AccountComputerConnectCodeIssueRequestSchema.parse({ accountId: crypto.randomUUID() })).toThrow();
  });

  it("keeps exchange as an installation report rather than a Computer identity hint", () => {
    const request = {
      code: "otcc_abcdefghijklmnopqrstuvwx",
      installationId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux" as const,
      arch: "x64",
      clientVersion: "0.0.2",
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
    expect(() =>
      ComputerProviderReadinessCollectionSchema.parse([
        { provider: "codex", status: "ready", observedAt: null },
        { provider: "codex", status: "checking", observedAt: null },
      ]),
    ).toThrow("Provider readiness must be unique");
  });

  it("enforces unique canonical order for IM CLI readiness", () => {
    expect(
      ComputerImCliReadinessCollectionSchema.parse([{ provider: "feishu", status: "ready", observedAt: null }]),
    ).toEqual([{ provider: "feishu", status: "ready", observedAt: null }]);
    expect(() =>
      ComputerImCliReadinessCollectionSchema.parse([
        { provider: "slack", status: "ready", observedAt: null },
        { provider: "slack", status: "checking", observedAt: null },
      ]),
    ).toThrow("IM CLI readiness must be unique");
    expect(() =>
      ComputerImCliReadinessCollectionSchema.parse([
        { provider: "slack", status: "ready", observedAt: null },
        { provider: "feishu", status: "checking", observedAt: null },
      ]),
    ).toThrow("IM CLI readiness must use canonical Provider order");
  });
});
