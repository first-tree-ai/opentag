import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as logfire from "logfire";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { initTelemetry, shutdownTelemetry } from "../logfire-init.js";
import { withRootSpan } from "../otel-helpers.js";

const PROCESS_EVENTS = ["beforeExit", "SIGTERM", "uncaughtExceptionMonitor", "unhandledRejection"] as const;
const processEmitter = process as unknown as {
  listeners(event: string): Array<(...args: never[]) => void>;
};

afterEach(async () => {
  await shutdownTelemetry();
});

describe("real Logfire trace pipeline", () => {
  it("exports only OpenTag scopes and leaves process shutdown and exception hooks to the application", async () => {
    const exporter = new InMemorySpanExporter();
    const listenersBefore = new Map(PROCESS_EVENTS.map((event) => [event, processEmitter.listeners(event)]));
    await initTelemetry(
      {
        endpoint: "https://collector.example.test/custom/v1/traces",
        environment: "test",
        headers: "x-api-key=not-sent-by-test",
        sampleRate: 1,
      },
      "pipeline-test-instance",
      { processor: new SimpleSpanProcessor(exporter) },
    );

    for (const event of PROCESS_EVENTS) expect(processEmitter.listeners(event)).toEqual(listenersBefore.get(event));

    const businessFailure = new Error("PRIVATE_PROVIDER_BODY");
    Object.assign(businessFailure, { code: "PRIVATE_TOOL_PAYLOAD" });
    await expect(withRootSpan("allowed.failure", undefined, () => Promise.reject(businessFailure))).rejects.toBe(
      businessFailure,
    );
    logfire.reportError("PRIVATE_LOGFIRE_ERROR_BODY", new Error("PRIVATE_LOGFIRE_STACK_AND_PROMPT"));

    const app = createApp();
    app.get("/pipeline-test", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/pipeline-test" });
    await app.close();
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["allowed.failure", "GET /pipeline-test"]));
    expect(
      spans.every((span) =>
        ["@opentag/server", "@autotelic/fastify-opentelemetry"].includes(span.instrumentationScope.name),
      ),
    ).toBe(true);
    const capture = JSON.stringify(
      spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
    );
    expect(capture).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(capture).not.toContain("PRIVATE_TOOL_PAYLOAD");
    expect(capture).not.toContain("PRIVATE_LOGFIRE_ERROR_BODY");
    expect(capture).not.toContain("PRIVATE_LOGFIRE_STACK_AND_PROMPT");

    await shutdownTelemetry();
    for (const event of PROCESS_EVENTS) expect(processEmitter.listeners(event)).toEqual(listenersBefore.get(event));
  });
});
