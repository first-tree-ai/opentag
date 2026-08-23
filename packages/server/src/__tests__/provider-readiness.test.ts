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

  it("carries the IM CLI incompatibility reason and detected version into the Computer projection", () => {
    expect(
      projectComputerImCliReadiness("computer-1", "online", now, {
        providerReadiness: () => [],
        imCliReadiness: () => [
          {
            observation: {
              provider: "slack",
              status: "unavailable",
              reason: "version_incompatible",
              detectedVersion: "4.1.0",
            },
            observedAt: now.getTime() - 1_000,
          },
        ],
      }),
    ).toEqual([
      { provider: "feishu", status: "checking", observedAt: null },
      {
        provider: "slack",
        status: "unavailable",
        reason: "version_incompatible",
        detectedVersion: "4.1.0",
        observedAt: "2026-08-19T23:59:59.000Z",
      },
    ]);
    expect(
      projectComputerImCliReadiness("computer-1", "offline", now, {
        providerReadiness: () => [],
        imCliReadiness: () => [
          {
            observation: {
              provider: "slack",
              status: "unavailable",
              reason: "version_incompatible",
              detectedVersion: "4.1.0",
            },
            observedAt: now.getTime(),
          },
        ],
      }),
    ).toEqual([
      { provider: "feishu", status: "unavailable", observedAt: null },
      { provider: "slack", status: "unavailable", observedAt: null },
    ]);
  });
});
