import { describe, expect, it, vi } from "vitest";
import type { ServiceLogger } from "../observability/service-logger.js";
import { classifyOutboundDestination } from "../services/outbound/destination-policy.js";

describe("classifyOutboundDestination", () => {
  it("admits public destination and returns pinned address", async () => {
    const url = new URL("https://example.com/api");
    const verdict = await classifyOutboundDestination(url, async () => ["93.184.216.34"]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.pin).toEqual({ address: "93.184.216.34", family: 4 });
    }
  });

  it("blocks private destination and logs structured warning when logger is provided", async () => {
    const warn = vi.fn();
    const logger = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    } as unknown as ServiceLogger;

    const url = new URL("https://internal.corp/secret");
    const verdict = await classifyOutboundDestination(url, async () => ["10.0.0.1"], { logger });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.failure).toEqual({ kind: "blocked", host: "internal.corp" });
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toEqual({
      module: "outbound-security",
      operation: "security.destination_blocked",
      outcome: "blocked",
      code: "DESTINATION_BLOCKED",
      errorCode: "DESTINATION_BLOCKED",
      host: "internal.corp",
      blockedAddress: "10.0.0.1",
    });
    expect(message).toBe("Outbound destination blocked by security policy");
  });

  it("blocks IPv6 private destination and logs structured warning", async () => {
    const warn = vi.fn();
    const logger = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => logger,
    } as unknown as ServiceLogger;

    const url = new URL("https://ipv6.internal/test");
    const verdict = await classifyOutboundDestination(url, {
      resolveAddresses: async () => ["fd00::1"],
      logger,
    });

    expect(verdict.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      module: "outbound-security",
      operation: "security.destination_blocked",
      outcome: "blocked",
      code: "DESTINATION_BLOCKED",
      errorCode: "DESTINATION_BLOCKED",
      host: "ipv6.internal",
      blockedAddress: "fd00::1",
    });
  });
});
