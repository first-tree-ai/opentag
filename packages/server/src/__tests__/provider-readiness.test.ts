import { describe, expect, it } from "vitest";
import { projectComputerProviderReadiness } from "../services/computers/provider-readiness.js";

const now = new Date("2026-08-20T00:00:00.000Z");

describe("Computer provider readiness projection", () => {
  it("projects a fresh Codex observation for an online Computer", () => {
    expect(
      projectComputerProviderReadiness("computer-1", "online", now, {
        providerReadiness: () => ({
          observation: { provider: "codex", status: "sign-in" },
          observedAt: now.getTime() - 1_000,
        }),
      }),
    ).toEqual({ provider: "codex", status: "sign-in", observedAt: "2026-08-19T23:59:59.000Z" });
  });

  it("treats a missing or stale online observation as checking", () => {
    expect(
      projectComputerProviderReadiness("computer-1", "online", now, {
        providerReadiness: () => undefined,
      }),
    ).toEqual({ provider: "codex", status: "checking", observedAt: null });
  });

  it("makes disconnect authoritative over the last observed provider state", () => {
    expect(
      projectComputerProviderReadiness("computer-1", "offline", now, {
        providerReadiness: () => ({
          observation: { provider: "codex", status: "ready" },
          observedAt: now.getTime(),
        }),
      }),
    ).toEqual({ provider: "codex", status: "unavailable", observedAt: null });
  });
});
