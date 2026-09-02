import { describe, expect, it } from "vitest";
import {
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "../services/computers/provider-readiness.js";

const now = new Date("2026-08-20T00:00:00.000Z");

describe("Computer provider readiness projection", () => {
  it("projects a fresh Codex observation for an online Computer", () => {
    expect(
      projectComputerProviderReadiness("computer-1", "online", now, {
        providerReadiness: () => [
          {
            observation: { provider: "codex", status: "sign-in" },
            observedAt: now.getTime() - 1_000,
          },
        ],
      }),
    ).toEqual([
      { provider: "codex", status: "sign-in", observedAt: "2026-08-19T23:59:59.000Z" },
      { provider: "claude-code", status: "checking", observedAt: null },
    ]);
  });

  it("treats a missing or stale online observation as checking", () => {
    expect(
      projectComputerProviderReadiness("computer-1", "online", now, {
        providerReadiness: () => [],
      }),
    ).toEqual([
      { provider: "codex", status: "checking", observedAt: null },
      { provider: "claude-code", status: "checking", observedAt: null },
    ]);
  });

  it("makes disconnect authoritative over the last observed provider state", () => {
    expect(
      projectComputerProviderReadiness("computer-1", "offline", now, {
        providerReadiness: () => [
          {
            observation: { provider: "codex", status: "ready" },
            observedAt: now.getTime(),
          },
        ],
      }),
    ).toEqual([
      { provider: "codex", status: "unavailable", observedAt: null },
      { provider: "claude-code", status: "unavailable", observedAt: null },
    ]);
  });
});

describe("Computer IM CLI readiness projection", () => {
  it("does not let an empty active observation collection hide the generic daemon observation", () => {
    expect(
      projectComputerImCliReadiness("computer-1", "online", now, {
        providerReadiness: () => [],
        providerCliArtifactReadiness: () => [],
        imCliReadiness: () => [
          {
            observation: { provider: "feishu", status: "install" },
            observedAt: now.getTime() - 1_000,
          },
          {
            observation: { provider: "slack", status: "ready" },
            observedAt: now.getTime() - 500,
          },
        ],
      }),
    ).toEqual([
      { provider: "feishu", status: "install", observedAt: "2026-08-19T23:59:59.000Z" },
      { provider: "slack", status: "ready", observedAt: "2026-08-19T23:59:59.500Z" },
    ]);
  });

  it("merges setup-prewarm observations with active-Integration artifact observations per provider", () => {
    expect(
      projectComputerImCliReadiness("computer-1", "online", now, {
        providerReadiness: () => [],
        providerCliArtifactReadiness: () => [
          {
            observation: {
              provider: "slack",
              status: "checking",
              agentId: "agent",
              integrationId: "integration",
              credentialGeneration: 1,
              requestId: "request",
            },
            observedAt: now.getTime(),
          },
        ],
        imCliReadiness: () => [
          {
            observation: { provider: "feishu", status: "ready" },
            observedAt: now.getTime() - 2_000,
          },
          {
            observation: { provider: "slack", status: "ready" },
            observedAt: now.getTime() - 2_000,
          },
        ],
      }),
    ).toEqual([
      { provider: "feishu", status: "ready", observedAt: "2026-08-19T23:59:58.000Z" },
      { provider: "slack", status: "checking", observedAt: now.toISOString() },
    ]);
  });
});
