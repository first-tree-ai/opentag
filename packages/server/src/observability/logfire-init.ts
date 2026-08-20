import { type Context, context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { configureLogfireApi } from "logfire";

export interface TracingConfig {
  endpoint: string;
  environment: string;
  headers: string;
  sampleRate: number;
}

const SERVICE_NAME = "opentag-server";
const SCRUB_PATTERNS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "credential",
  "password",
  "content",
  "body",
  "payload",
  "prompt",
  "output",
  "sender",
  "author",
];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ALLOWED_INSTRUMENTATION_SCOPES = new Set(["@autotelic/fastify-opentelemetry", "@opentag/server"]);

let enabled = false;
let shutdownPromise: Promise<void> | undefined;
let telemetryProvider: NodeTracerProvider | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;

export function parseHeaderString(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const normalizedNames = new Set<string>();
  if (!raw.trim()) return headers;
  for (const fragment of raw.split(",")) {
    if (/[\r\n]/.test(fragment)) throw new Error("OPENTAG_OTEL_HEADERS contains an invalid header entry");
    const pair = fragment.trim();
    if (!pair) throw new Error("OPENTAG_OTEL_HEADERS contains an empty header entry");
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error("OPENTAG_OTEL_HEADERS must use comma-separated key=value entries");
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const normalizedName = key.toLowerCase();
    if (!HEADER_NAME.test(key) || !value || /[\r\n]/.test(value)) {
      throw new Error("OPENTAG_OTEL_HEADERS contains an invalid header entry");
    }
    if (normalizedNames.has(normalizedName)) throw new Error("OPENTAG_OTEL_HEADERS contains a duplicate header");
    normalizedNames.add(normalizedName);
    headers[key] = value;
  }
  return headers;
}

export async function initTelemetry(
  config: TracingConfig,
  instanceId: string,
  options: { exporter?: SpanExporter; processor?: SpanProcessor } = {},
): Promise<void> {
  if (enabled) await shutdownTelemetry();
  shutdownPromise = undefined;
  if (!config.endpoint) return;

  const headers = parseHeaderString(config.headers);
  const processor = new AllowlistedSpanProcessor(
    options.processor ??
      new BatchSpanProcessor(options.exporter ?? new OTLPTraceExporter({ url: config.endpoint, headers })),
  );

  configureLogfireApi({
    errorFingerprinting: false,
    otelScope: "logfire",
    scrubbing: { extraPatterns: SCRUB_PATTERNS },
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "deployment.environment.name": config.environment,
      "service.instance.id": instanceId,
      "service.name": SERVICE_NAME,
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
    spanProcessors: [processor],
  });
  const manager = new AsyncLocalStorageContextManager();
  provider.register({ contextManager: manager });
  telemetryProvider = provider;
  contextManager = manager;
  enabled = true;
}

class AllowlistedSpanProcessor implements SpanProcessor {
  constructor(readonly delegate: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    if (ALLOWED_INSTRUMENTATION_SCOPES.has(span.instrumentationScope.name)) {
      this.delegate.onStart(span, parentContext);
    }
  }

  onEnding(span: Span): void {
    if (ALLOWED_INSTRUMENTATION_SCOPES.has(span.instrumentationScope.name)) this.delegate.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    if (ALLOWED_INSTRUMENTATION_SCOPES.has(span.instrumentationScope.name)) this.delegate.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function shutdownTelemetry(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (!enabled) return Promise.resolve();
  enabled = false;
  const provider = telemetryProvider;
  const manager = contextManager;
  telemetryProvider = undefined;
  contextManager = undefined;
  shutdownPromise = (provider?.shutdown() ?? Promise.resolve())
    .catch(() => undefined)
    .finally(() => {
      manager?.disable();
      trace.disable();
      context.disable();
      propagation.disable();
    });
  return shutdownPromise;
}
