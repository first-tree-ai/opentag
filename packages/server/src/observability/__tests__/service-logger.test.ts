import { describe, expect, it, vi } from "vitest";
import { createServiceLoggerPort } from "../service-logger.js";

describe("service logger port", () => {
  it("adds the module and redacts payload values", () => {
    const info = vi.fn();
    const logger = createServiceLoggerPort(() => ({ info }) as never, "agent-service");

    logger.info({ error: { message: "Authorization: Bearer private-token" } }, "Agent operation failed");

    expect(info).toHaveBeenCalledWith(
      { module: "agent-service", error: { message: "Authorization: [REDACTED]" } },
      "Agent operation failed",
    );
  });

  it("redacts and caps the message argument, not only the bindings", () => {
    const error = vi.fn();
    const logger = createServiceLoggerPort(() => ({ error }) as never, "im-delivery");

    logger.error({ deliveryId: "d-1" }, "provider rejected: Authorization: Bearer message-secret");

    const [, message] = error.mock.calls[0] as [unknown, string];
    expect(message).not.toContain("message-secret");
    expect(message).toContain("[REDACTED]");

    logger.error({}, "y".repeat(20_000));
    const [, longMessage] = error.mock.calls[1] as [unknown, string];
    expect(new TextEncoder().encode(longMessage).byteLength).toBeLessThanOrEqual(4 * 1024);
  });

  it("tolerates absent and failing loggers", () => {
    const logger = createServiceLoggerPort(() => undefined, "module");
    expect(() => logger.error({ value: "safe" }, "ignored")).not.toThrow();

    const failing = createServiceLoggerPort(() => {
      throw new Error("logger unavailable");
    }, "module");
    expect(() => failing.warn({ value: "safe" }, "ignored")).not.toThrow();
  });
});
