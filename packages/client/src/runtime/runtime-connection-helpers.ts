import {
  type HeartbeatResultFrame,
  RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_V2,
  type RuntimeChannelTarget,
  RuntimeCredentialServerFrameSchema,
  type RuntimeNegotiatedCapabilities,
  type RuntimeProtocolVersion,
  redactForLog,
  ServerRuntimeBusinessFrameSchema,
} from "@opentag/shared";
import type { RawData } from "ws";
import type { ClientLogger } from "../observability/logger.js";

export type RuntimeBusinessFrame = Readonly<Record<string, unknown>> & { readonly type: string };

/**
 * Every frame the Server may send on the business channel.
 *
 * Two independent vocabularies share this channel. `ServerRuntimeBusinessFrameSchema` covers the
 * domain frames — deliveries, reconciles, report results. The runtime-credential control plane
 * (execution open/close, capability results, proxy tickets, the MCP gateway token) is its own union,
 * which the relay parses again itself once a frame is delivered.
 *
 * Both attempts are needed. A credential result that fails to parse here is treated as an invalid
 * frame and the connection is dropped, so the relay's request can never be answered. Nothing noticed
 * because the relay only runs in proxy mode, which is opt-in and off by default.
 */
export function parseServerBusinessFrame(value: unknown): RuntimeBusinessFrame | undefined {
  const domain = ServerRuntimeBusinessFrameSchema.safeParse(value);
  if (domain.success) return domain.data;
  const credential = RuntimeCredentialServerFrameSchema.safeParse(value);
  return credential.success ? (credential.data as unknown as RuntimeBusinessFrame) : undefined;
}

export function notifyTarget(
  protocolVersion: RuntimeProtocolVersion,
  capabilities: RuntimeNegotiatedCapabilities,
  frame: HeartbeatResultFrame,
  listener: ((target: RuntimeChannelTarget) => void) | undefined,
  logger: ClientLogger,
): void {
  if (
    protocolVersion !== RUNTIME_PROTOCOL_V2 ||
    capabilities[RUNTIME_CAPABILITY.channelTarget] === undefined ||
    !("channelTarget" in frame) ||
    !frame.channelTarget
  ) {
    return;
  }
  try {
    listener?.(frame.channelTarget);
  } catch {
    logger.warn({ category: "listener" }, "Runtime channel target listener failed");
  }
}

export function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function redactRuntimeReason(message: string): string {
  return redactForLog(message);
}

export function protocolRejectionFields(attempt: number, state: string, message: string) {
  return { attempt: attempt + 1, category: "protocol", reason: redactRuntimeReason(message), state };
}
