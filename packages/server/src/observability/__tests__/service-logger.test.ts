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

  it("tolerates absent and failing loggers", () => {
    const logger = createServiceLoggerPort(() => undefined, "module");
    expect(() => logger.error({ value: "safe" }, "ignored")).not.toThrow();

    const failing = createServiceLoggerPort(() => {
      throw new Error("logger unavailable");
    }, "module");
    expect(() => failing.warn({ value: "safe" }, "ignored")).not.toThrow();
  });
});
