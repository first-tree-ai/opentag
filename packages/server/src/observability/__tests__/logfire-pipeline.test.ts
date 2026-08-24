import { Writable } from "node:stream";
import { SpanStatusCode, trace } from "@opentelemetry/api";
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
  /*
   * Deliberate injection rather than a driven failure path. The route code normally never hands a body,
   * a token, or a signing secret to a logger or a span, so a test that only provokes an ordinary failure
   * would pass even with every scrubber removed. These assertions push credential material straight at
   * both sinks — the pino transport and the span exporter — and require that neither receives it.
   */
  it("keeps injected Slack credential material out of the log sink and the span exporter", async () => {
    /*
     * Assembled at runtime rather than written as literals: a complete token-shaped string in source
     * trips GitHub push protection even though these are fixtures. The runtime values still carry the
     * real `xoxb-` and `xapp-` prefixes the scrubbers key on.
     */
    const BOT_TOKEN = ["xoxb", "1".repeat(11), "2".repeat(12), "INJECTEDBOTFIXTURE"].join("-");
    const APP_TOKEN = ["xapp", "1", `A${"3".repeat(10)}`, "INJECTEDAPPFIXTURE"].join("-");
    const SIGNING_SECRET = "4".repeat(32);

    const exporter = new InMemorySpanExporter();
    await initTelemetry(
      {
        endpoint: "https://collector.example.test/custom/v1/traces",
        environment: "test",
        headers: "x-api-key=not-sent-by-test",
        sampleRate: 1,
      },
      "scrubbing-test-instance",
      { processor: new SimpleSpanProcessor(exporter) },
    );

    let logs = "";
    const loggerStream = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    });
    const app = createApp({ loggerStream });

    // Sink 1: the real Fastify logger, handed credentials both as structured fields and inside an Error.
    const failure = new Error(`slack rejected ${BOT_TOKEN} for signingSecret=${SIGNING_SECRET}`);
    app.log.error(
      {
        err: failure,
        botAccessToken: BOT_TOKEN,
        binding: { signingSecret: SIGNING_SECRET, nested: { appSecret: APP_TOKEN } },
        bindings: [{ token: BOT_TOKEN }],
      },
      "expected test error",
    );
    app.log.info({ authorization: `Bearer ${BOT_TOKEN}` }, `raw message with ${APP_TOKEN}`);

    // Sink 2: the span pipeline, written with raw OpenTelemetry calls that bypass the tracing helpers.
    await withRootSpan("scrubbing.injection", undefined, () => {
      const span = trace.getActiveSpan();
      span?.setAttribute("opentag.test.raw_attribute", `token ${BOT_TOKEN}`);
      span?.setAttribute("opentag.test.raw_array", [`signingSecret=${SIGNING_SECRET}`, APP_TOKEN]);
      span?.setAttribute("botAccessToken", BOT_TOKEN);
      span?.addEvent("opentag.test.event", { "opentag.test.detail": `secret=${SIGNING_SECRET} ${BOT_TOKEN}` });
      span?.recordException(new Error(`raw exception carrying ${BOT_TOKEN} and appSecret=${SIGNING_SECRET}`));
      span?.setStatus({ code: SpanStatusCode.ERROR, message: `status carrying ${APP_TOKEN}` });
    });

    await app.close();

    const spans = exporter.getFinishedSpans().filter((span) => span.name === "scrubbing.injection");
    expect(spans).toHaveLength(1);
    const spanCapture = JSON.stringify(
      spans.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })),
    );
    for (const [sink, capture] of [
      ["log sink", logs],
      ["span exporter", spanCapture],
    ] as const) {
      expect(capture, `${sink} leaked the bot token`).not.toContain(BOT_TOKEN);
      expect(capture, `${sink} leaked the app-level token`).not.toContain(APP_TOKEN);
      expect(capture, `${sink} leaked the signing secret`).not.toContain(SIGNING_SECRET);
      expect(capture, `${sink} leaked a Slack token prefix`).not.toMatch(/xox[a-z]-\w/);
    }
    // The surrounding record still has to be useful, or the assertions above would pass on empty output.
    expect(logs).toContain("expected test error");
    expect(spans[0]?.attributes["opentag.test.raw_attribute"]).toBeDefined();
    expect(spans[0]?.events.map((event) => event.name)).toContain("opentag.test.event");
  });
});
