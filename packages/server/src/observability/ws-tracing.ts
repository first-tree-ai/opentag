import type { Context, Span } from "@opentelemetry/api";
import { context as otelContext, trace } from "@opentelemetry/api";
import type WebSocket from "ws";
import { OPENTAG_ATTR, outcomeAttrs, runtimeAttrs } from "./attributes.js";
import { endSpan, normalizeTelemetryAttrs, startTrackedSpan } from "./otel-helpers.js";

interface RuntimeConnectionTrace {
  context: Context;
  span: Span;
}

export interface RuntimeFrameTrace {
  context: Context;
  ended: boolean;
  span: Span;
}

const connections = new WeakMap<WebSocket, RuntimeConnectionTrace>();

export function startRuntimeConnectionSpan(socket: WebSocket): void {
  const span = startTrackedSpan("runtime.ws.connection");
  connections.set(socket, { span, context: trace.setSpan(otelContext.active(), span) });
}

export function setRuntimeConnectionAttrs(socket: WebSocket, attrs: Record<string, unknown>): void {
  try {
    connections.get(socket)?.span.setAttributes(normalizeTelemetryAttrs(attrs));
  } catch {
    // Connection tracing is observational only.
  }
}

export function endRuntimeConnectionSpan(socket: WebSocket, closeCode?: number): void {
  const entry = connections.get(socket);
  if (!entry) return;
  endSpan(entry.span, {
    [OPENTAG_ATTR.WS_CLOSE_CODE]: closeCode,
    ...outcomeAttrs(closeCode === undefined || closeCode === 1000 ? "closed" : "failed"),
  });
  connections.delete(socket);
}

export async function withRuntimeFrameSpan<T>(
  socket: WebSocket,
  type: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const frameTrace = startRuntimeFrameSpan(socket, type, attrs);
  try {
    const result = await runInRuntimeFrameSpan(frameTrace, fn);
    endRuntimeFrameSpan(frameTrace, "handled");
    return result;
  } catch (error) {
    endRuntimeFrameSpan(frameTrace, "failed", "RUNTIME_FRAME_FAILED");
    throw error;
  }
}

export function startRuntimeFrameSpan(
  socket: WebSocket,
  type: string,
  attrs: Record<string, unknown>,
): RuntimeFrameTrace | undefined {
  if (type === "heartbeat") return undefined;
  const entry = connections.get(socket);
  if (!entry) return undefined;
  const span = startTrackedSpan(
    `runtime.ws.frame ${boundedFrameType(type)}`,
    { ...runtimeAttrs({ frameType: type }), ...attrs },
    { parentContext: entry.context },
  );
  return { span, context: trace.setSpan(entry.context, span), ended: false };
}

export function runInRuntimeFrameSpan<T>(
  frameTrace: RuntimeFrameTrace | undefined,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return frameTrace ? otelContext.with(frameTrace.context, fn) : fn();
}

export function endRuntimeFrameSpan(
  frameTrace: RuntimeFrameTrace | undefined,
  outcome: string,
  errorCode?: string,
): void {
  if (!frameTrace || frameTrace.ended) return;
  frameTrace.ended = true;
  endSpan(
    frameTrace.span,
    outcomeAttrs(outcome, errorCode),
    errorCode === "RUNTIME_FRAME_FAILED" ? new Error(errorCode) : undefined,
  );
}

function boundedFrameType(type: string): string {
  return /^[a-z][a-z0-9:-]{0,63}$/.test(type) ? type : "unknown";
}
