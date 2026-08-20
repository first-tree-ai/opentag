import { describe, expect, it } from "vitest";
import { ComputerSchema, ListComputersResponseSchema } from "../computer.js";

const computer = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  ownerUserId: "bfcdab09-b57a-44ac-a170-09f7c3af20df",
  displayName: "workstation",
  platform: "linux",
  arch: "x64",
  clientVersion: "0.0.1",
  connectionStatus: "online",
  providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-18T00:00:01.000Z" }],
  connectedAt: "2026-08-18T00:00:00.000Z",
  lastSeenAt: "2026-08-18T00:00:01.000Z",
};

describe("computer contracts", () => {
  it("validates list projections", () => {
    expect(ListComputersResponseSchema.parse({ computers: [computer] })).toEqual({ computers: [computer] });
    const { providerReadiness: _providerReadiness, ...legacyComputer } = computer;
    expect(ListComputersResponseSchema.parse({ computers: [legacyComputer] })).toEqual({
      computers: [legacyComputer],
    });
  });

  it("rejects authority and unsupported platform fields", () => {
    expect(() => ComputerSchema.parse({ ...computer, teamId: crypto.randomUUID() })).toThrow();
    expect(() => ComputerSchema.parse({ ...computer, platform: "freebsd" })).toThrow();
    expect(() =>
      ComputerSchema.parse({
        ...computer,
        providerReadiness: [
          { provider: "claude-code", status: "ready", observedAt: null },
          { provider: "codex", status: "ready", observedAt: null },
        ],
      }),
    ).toThrow();
  });
});
