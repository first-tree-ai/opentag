import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudDeliveryLatency } from "../observability/cloud-latency.js";
import type { ServiceLogger } from "../observability/service-logger.js";

const sessionId = randomUUID();
const env = {
  OPENTAG_ENV: "staging",
  OPENTAG_CLOUD_LATENCY_DIAGNOSTICS: "true",
  OPENTAG_CLOUD_LATENCY_SESSION_IDS: sessionId,
};
function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies ServiceLogger;
}

describe("Server Cloud delivery measurement admission", () => {
  it("defaults off, requires a logger and isolates selected Sessions", () => {
    const sink = logger();
    expect(new CloudDeliveryLatency({}, sink).begin(sessionId, randomUUID(), 1)).toBeUndefined();
    expect(new CloudDeliveryLatency(env).begin(sessionId, randomUUID(), 1)).toBeUndefined();
    expect(new CloudDeliveryLatency(env, sink).begin(randomUUID(), randomUUID(), 1)).toBeUndefined();
    expect(sink.info).not.toHaveBeenCalled();
  });

  it("observes distinct attempts while suppressing duplicates and bounding delivery bookkeeping", () => {
    const sink = logger();
    const observer = new CloudDeliveryLatency(env, sink);
    const deliveryId = randomUUID();
    const trace = observer.begin(sessionId, deliveryId, 3);
    trace?.start("runtime_assembly");
    trace?.end("runtime_assembly");
    trace?.finish("completed");
    expect(sink.info).toHaveBeenCalledTimes(3);
    expect(sink.info.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      deliveryId,
      attempt: 3,
      service: "opentag-server",
    });
    expect(observer.begin(sessionId, deliveryId, 3)).toBeUndefined();
    const retry = observer.begin(sessionId, deliveryId, 4);
    expect(retry).toBeDefined();
    retry?.finish("completed");
    expect(sink.info.mock.calls.at(-1)?.[0]).toMatchObject({ deliveryId, attempt: 4 });
    for (let index = 1; index < 1024; index++) expect(observer.begin(sessionId, randomUUID(), 1)).toBeDefined();
    expect(observer.begin(sessionId, randomUUID(), 1)).toBeUndefined();
  });

  it("shares one 32-record budget across retries and reserves its last summary", () => {
    const sink = logger();
    const observer = new CloudDeliveryLatency(env, sink);
    const deliveryId = randomUUID();
    for (let attempt = 1; attempt < 100; attempt++) {
      const trace = observer.begin(sessionId, deliveryId, attempt);
      trace?.start("allocation_wait");
      trace?.end("allocation_wait", "failed");
      trace?.finish("incomplete");
    }
    expect(sink.info).toHaveBeenCalledTimes(32);
    expect(sink.info.mock.calls.at(-1)?.[0]).toMatchObject({ event: "summary", diagnosticIncomplete: true });
    expect(Buffer.byteLength(JSON.stringify(sink.info.mock.calls))).toBeLessThan(64 * 1024);
  });

  it("invalid identities and logging failures remain observational", async () => {
    const sink = logger();
    sink.info.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const observer = new CloudDeliveryLatency(env, sink);
    expect(observer.begin(sessionId, "secret:bad-id", 1)).toBeUndefined();
    const trace = observer.begin(sessionId, randomUUID(), 1);
    expect(await trace?.measure("allocation_wait", async () => "unchanged")).toBe("unchanged");
    expect(() => trace?.finish("completed")).not.toThrow();
  });
});
