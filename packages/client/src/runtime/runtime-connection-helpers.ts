import {
  type HeartbeatResultFrame,
  RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_V2,
  type RuntimeChannelTarget,
  type RuntimeNegotiatedCapabilities,
  type RuntimeProtocolVersion,
  redactForLog,
} from "@opentag/shared";
import type { RawData } from "ws";
import type { ClientLogger } from "../observability/logger.js";

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
