import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exporterShutdown = vi.hoisted(() => vi.fn(async () => undefined));
const traceExporter = vi.hoisted(() =>
  vi.fn(function (this: {
    export: (spans: unknown[], callback: (result: { code: number }) => void) => void;
    shutdown: () => Promise<void>;
  }) {
    this.export = (_spans, callback) => callback({ code: 0 });
    this.shutdown = exporterShutdown;
  }),
);
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({ OTLPTraceExporter: traceExporter }));

import {
  AllowlistedSpanProcessor,
  initTelemetry,
  isTelemetryEnabled,
  parseHeaderString,
  shutdownTelemetry,
} from "../logfire-init.js";

beforeEach(async () => {
  await shutdownTelemetry();
  traceExporter.mockClear();
  exporterShutdown.mockClear();
});

afterEach(async () => {
  await shutdownTelemetry();
});

describe("Logfire lifecycle", () => {
  it("is a transparent no-op when the OTLP endpoint is empty", async () => {
    await initTelemetry({ endpoint: "", environment: "test", headers: "", sampleRate: 1 }, "server-instance-off");
    expect(isTelemetryEnabled()).toBe(false);
    expect(traceExporter).not.toHaveBeenCalled();
  });

  it("configures an explicit trace-only OTLP pipeline with canonical service resources", async () => {
    await initTelemetry(
      {
        endpoint: "https://collector.example.test/custom/otel/v1/traces",
        environment: "production",
        headers: "x-api-key=collector-key,x-tenant=tenant-1",
        sampleRate: 0.5,
      },
      "server-instance-1",
    );

    expect(isTelemetryEnabled()).toBe(true);
    expect(traceExporter).toHaveBeenCalledWith({
      url: "https://collector.example.test/custom/otel/v1/traces",
      headers: { "x-api-key": "collector-key", "x-tenant": "tenant-1" },
    });
  });

  it("flushes exactly once across competing shutdown calls", async () => {
    await initTelemetry(
      {
        endpoint: "https://logfire-us.pydantic.dev/v1/traces",
        environment: "test",
        headers: "Authorization=Bearer pylf_test",
        sampleRate: 1,
      },
      "server-instance-2",
    );
    await Promise.all([shutdownTelemetry(), shutdownTelemetry(), shutdownTelemetry()]);
    expect(exporterShutdown).toHaveBeenCalledTimes(1);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("rejects malformed or duplicate headers without echoing their values", async () => {
    const headers = "x-api-key=never-print-this,broken";
    await expect(
      initTelemetry(
        {
          endpoint: "https://collector.example.test/v1/traces",
          environment: "test",
          headers,
          sampleRate: 1,
        },
        "server-instance-3",
      ),
    ).rejects.not.toThrow(headers);
    expect(traceExporter).not.toHaveBeenCalled();
    expect(() => parseHeaderString("x-api-key=one,X-API-Key=two")).toThrow("duplicate header");
    expect(() => parseHeaderString("x-api-key=\r\nsecret")).toThrow("invalid header");
    expect(() => parseHeaderString("x api=value")).toThrow("invalid header");
    expect(() => parseHeaderString("x-api-key=")).toThrow("invalid header");
  });

  it("forwards force-flush requests through the allowlisted processor", async () => {
    const forceFlush = vi.fn(async () => undefined);
    const processor = {
      forceFlush,
      onStart: vi.fn(),
      onEnd: vi.fn(),
      onEnding: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    await initTelemetry(
      {
        endpoint: "https://collector.example.test/v1/traces",
        environment: "test",
        headers: "",
        sampleRate: 1,
      },
      "server-instance-force-flush",
      { processor },
    );

    await new AllowlistedSpanProcessor(processor).forceFlush();
    expect(forceFlush).toHaveBeenCalledOnce();
  });
});
