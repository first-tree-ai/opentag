import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
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

  it("preserves raw Error instances through serviceLogger into Fastify logger serializer without producing [object Object]", async () => {
    const logs: string[] = [];
    const stream = {
      write: (chunk: string) => {
        logs.push(chunk);
        return true;
      },
    };
    const app = createApp({ loggerStream: stream, loggerLevel: "error" });
    try {
      const logger = createServiceLoggerPort(() => app.log, "runtime-test");

      logger.error({ err: new Error("sample error") }, "Operation failed");
      expect(logs).toHaveLength(1);
      const firstChunk = logs[0] ?? "";
      const parsed = JSON.parse(firstChunk);
      expect(parsed.module).toBe("runtime-test");
      expect(parsed.err).toBeDefined();
      expect(parsed.err.message).toBe("sample error");
      expect(parsed.err.type).toBe("Error");
      expect(JSON.stringify(parsed)).not.toContain("[object Object]");

      // Also verify when passed as `error` key instead of `err`
      logger.error({ error: new Error("error key test") }, "Second operation failed");
      expect(logs).toHaveLength(2);
      const secondChunk = logs[1] ?? "";
      const secondParsed = JSON.parse(secondChunk);
      expect(secondParsed.err).toBeDefined();
      expect(secondParsed.err.message).toBe("error key test");
      expect(JSON.stringify(secondParsed)).not.toContain("[object Object]");
    } finally {
      await app.close();
    }
  });
});
