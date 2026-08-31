import { describe, expect, it } from "vitest";
import {
  AccountComputerConnectCodeIssueRequestSchema,
  ComputerConnectCodeExchangeRequestSchema,
  ComputerConnectCodeExchangeResponseSchema,
  ComputerConnectCodeIssueResponseSchema,
  ComputerConnectCodeStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerProviderReadinessCollectionSchema,
} from "../computer.js";

describe("computer contracts", () => {
  it("returns Computer-scoped machine authority without a management Workspace alias", () => {
    const response = {
      workspaceComputerId: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      machineToken: "opaque-secret",
    };
    expect(ComputerConnectCodeExchangeResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      ComputerConnectCodeExchangeResponseSchema.parse({ ...response, workspaceId: crypto.randomUUID() }),
    ).toThrow();
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
      connectCodeId: crypto.randomUUID(),
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

  it("requires the non-secret connectCodeId on the issue response", () => {
    const response = {
      bootstrapCommand: "opentag computer connect --server https://opentag.example -- otcc_code",
      expiresIn: 900,
      issuedAt: "2026-08-29T00:00:00.000Z",
    };
    expect(() => ComputerConnectCodeIssueResponseSchema.parse(response)).toThrow();
    expect(() => ComputerConnectCodeIssueResponseSchema.parse({ ...response, connectCodeId: "not-a-uuid" })).toThrow();
  });

  it("correlates a redeemed code with exactly the Computer that redeemed it, and nothing else", () => {
    const connectCodeId = crypto.randomUUID();
    const computerId = crypto.randomUUID();
    const redeemed = {
      connectCodeId,
      state: "redeemed",
      computerId,
      redeemedAt: "2026-08-29T00:00:10.000Z",
    };
    expect(ComputerConnectCodeStatusSchema.parse(redeemed)).toEqual(redeemed);

    for (const state of ["pending", "expired", "revoked"] as const) {
      const quiet = { connectCodeId, state, computerId: null, redeemedAt: null };
      expect(ComputerConnectCodeStatusSchema.parse(quiet)).toEqual(quiet);
    }

    // The correlation read must never become a channel for the code, its hash, or a machine token.
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, code: "otcc_raw" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, tokenHash: "abc123" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, machineToken: "otmc_secret" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, state: "consumed" })).toThrow();
    expect(() => ComputerConnectCodeStatusSchema.parse({ ...redeemed, computerId: null })).toThrow();
    expect(() =>
      ComputerConnectCodeStatusSchema.parse({
        connectCodeId,
        state: "pending",
        computerId,
        redeemedAt: "2026-08-29T00:00:10.000Z",
      }),
    ).toThrow();
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
