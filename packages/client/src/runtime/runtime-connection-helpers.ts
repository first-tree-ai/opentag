import {
  type HeartbeatResultFrame,
  RUNTIME_CAPABILITY,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V1,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_REQUIRED_SERVER_CAPABILITIES,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
  type RuntimeCapabilityOffers,
  type RuntimeChannelTarget,
  type RuntimeClientCapabilities,
  RuntimeFrameEnvelopeSchema,
  type RuntimeImCliReadinessCollection,
  type RuntimeNegotiatedCapabilities,
  type RuntimeProtocolVersion,
  type RuntimeProviderReadinessCollection,
  redactForLog,
  runtimeNegotiatedCapabilitiesEqual,
  ServerRuntimeBusinessFrameSchema,
  type ServerRuntimeFrameSchema,
  type ServerWelcomeFrame,
} from "@opentag/shared";
import type { RawData } from "ws";
import { OpenTagApiError } from "../api.js";
import type { ClientLogger } from "../observability/logger.js";
import { RuntimeConnectionError, runtimeConnectionErrorCategory } from "./runtime-connection-errors.js";
import { parseRuntimeCredentialServerFrame } from "./runtime-credential-frames.js";
import type { HeartbeatAcknowledgements } from "./runtime-self-check.js";

export type RuntimeBusinessFrame = Readonly<Record<string, unknown>> & { readonly type: string };
export type ServerRuntimeFrame = ReturnType<typeof ServerRuntimeFrameSchema.parse>;

export type RuntimeConnectionLifecycleState =
  | "stopped"
  | "connecting"
  | "authenticating"
  | "welcoming"
  | "registering"
  | "registered";

export interface RuntimeTimerScheduler {
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
}

export const EXPECTED_CONTROL_FRAME_STATE: Record<
  Exclude<ServerRuntimeFrame["type"], "error">,
  RuntimeConnectionLifecycleState
> = {
  "auth:result": "authenticating",
  "server:welcome": "welcoming",
  "computer:register:result": "registering",
  "heartbeat:result": "registered",
};

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
  const credential = parseRuntimeCredentialServerFrame(value);
  return credential ? (credential as unknown as RuntimeBusinessFrame) : undefined;
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

export function protocolRejectionFields(attempt: number, state: string, message: string, category = "protocol") {
  return { attempt: attempt + 1, category, reason: redactRuntimeReason(message), state };
}

export function classifyFatalRunError(
  error: unknown,
  attempt: number,
  state: RuntimeConnectionLifecycleState,
  logger: ClientLogger,
): RuntimeConnectionError | undefined {
  if (error instanceof RuntimeConnectionError && error.fatal) {
    logger.error(
      protocolRejectionFields(attempt, state, error.message, error.category),
      "Runtime connection was rejected",
    );
    return error;
  }
  if (error instanceof OpenTagApiError && !["transient", "rate_limit"].includes(error.category)) {
    logger.error({ attempt: attempt + 1, category: error.category, state }, "Runtime authentication failed");
    return new RuntimeConnectionError(`${error.message}; run opentag connect again`, true, "authentication_rejection");
  }
  if (error instanceof Error && error.message.includes("not logged in")) {
    logger.error({ attempt: attempt + 1, category: "credential", state }, "Runtime authentication failed");
    return new RuntimeConnectionError(`${error.message}; run opentag connect first`, true, "authentication_rejection");
  }
  return undefined;
}

export function buildAuthFrame(requestId: string, protocolVersion: RuntimeProtocolVersion, machineToken: string) {
  return protocolVersion === RUNTIME_PROTOCOL_V2
    ? {
        type: "auth" as const,
        requestId,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
        machineToken,
      }
    : {
        type: "auth" as const,
        requestId,
        protocolVersion: RUNTIME_PROTOCOL_V1,
        machineToken,
      };
}

export interface BuildRegisterFrameInput {
  requestId: string;
  protocolVersion: RuntimeProtocolVersion;
  installationId: string;
  instanceId: string;
  displayName: string;
  platform: "darwin" | "linux" | "win32";
  arch: string;
  clientVersion: string;
  capabilities: RuntimeClientCapabilities;
  providerReadiness?: RuntimeProviderReadinessCollection;
  imCliReadiness: RuntimeImCliReadinessCollection;
  supportedCapabilities: RuntimeCapabilityOffers;
}

export function buildRegisterFrame(input: BuildRegisterFrameInput) {
  const registration = {
    type: "computer:register" as const,
    requestId: input.requestId,
    installationId: input.installationId,
    instanceId: input.instanceId,
    displayName: input.displayName,
    platform: input.platform,
    arch: input.arch,
    clientVersion: input.clientVersion,
    capabilities: input.capabilities,
    ...(input.providerReadiness ? { providerReadiness: input.providerReadiness } : {}),
    imCliReadiness: input.imCliReadiness,
  };
  return input.protocolVersion === RUNTIME_PROTOCOL_V2
    ? {
        ...registration,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        supportedCapabilities: input.supportedCapabilities,
        requiredServerCapabilities: RUNTIME_REQUIRED_SERVER_CAPABILITIES,
      }
    : registration;
}

export function hasStaleBusinessFrameFence(
  protocolVersion: RuntimeProtocolVersion,
  envelopeConnectionId: string | undefined,
  activeConnectionId: string | undefined,
): boolean {
  return protocolVersion === RUNTIME_PROTOCOL_V2 && envelopeConnectionId !== activeConnectionId;
}

export function evaluateHeartbeatPendingStatus(
  fixedCadence: boolean,
  fixedHeartbeats: HeartbeatAcknowledgements,
  requestId: string,
  pendingHeartbeatRequestId: string | undefined,
): { acknowledged: boolean; matchesPending: boolean } {
  const acknowledged = fixedCadence && fixedHeartbeats.wasAcknowledged(requestId);
  const matchesPending = fixedCadence
    ? fixedHeartbeats.isPending(requestId) || acknowledged
    : requestId === pendingHeartbeatRequestId;
  return { acknowledged, matchesPending };
}

export function createHeartbeatRejectionError(errorCode: string | undefined): RuntimeConnectionError {
  const category = runtimeConnectionErrorCategory(errorCode, true, false);
  return new RuntimeConnectionError(
    `Runtime heartbeat failed: ${errorCode}`,
    category !== "transient_connection",
    category,
  );
}

export function completeHeartbeatSuccess(
  fixedCadence: boolean,
  fixedHeartbeats: HeartbeatAcknowledgements,
  requestId: string,
  scheduler: RuntimeTimerScheduler,
  heartbeatResultTimer: ReturnType<typeof setTimeout> | undefined,
  scheduleHeartbeat: () => void,
): void {
  if (fixedCadence) {
    fixedHeartbeats.acknowledge(requestId);
  }
  if (heartbeatResultTimer) scheduler.clearTimeout(heartbeatResultTimer);
  if (!fixedCadence) scheduleHeartbeat();
}

export interface ControlFrameHandlers {
  onAuthResult: (frame: Extract<ServerRuntimeFrame, { type: "auth:result" }>) => void;
  onWelcome: (frame: ServerWelcomeFrame) => void;
  onRegisterResult: (frame: Extract<ServerRuntimeFrame, { type: "computer:register:result" }>) => void;
  onHeartbeatResult: (frame: Extract<ServerRuntimeFrame, { type: "heartbeat:result" }>) => void;
}

export function dispatchInOrderControlFrame(
  frame: Exclude<ServerRuntimeFrame, { type: "error" }>,
  handlers: ControlFrameHandlers,
): void {
  switch (frame.type) {
    case "auth:result":
      handlers.onAuthResult(frame);
      return;
    case "server:welcome":
      handlers.onWelcome(frame);
      return;
    case "computer:register:result":
      handlers.onRegisterResult(frame);
      return;
    case "heartbeat:result":
      handlers.onHeartbeatResult(frame);
      return;
  }
}

export function decodeIncomingFrameEnvelope(
  data: RawData,
  isBinary: boolean,
):
  | { ok: false; message: string; reason: string }
  | { ok: true; decoded: unknown; envelope: ReturnType<typeof RuntimeFrameEnvelopeSchema.parse> } {
  if (isBinary) {
    return { ok: false, message: "The server sent a binary runtime frame", reason: "Binary frames are not supported" };
  }
  const buffer = rawDataBuffer(data);
  if (buffer.byteLength > RUNTIME_MAX_FRAME_BYTES) {
    return { ok: false, message: "The server sent an oversized runtime frame", reason: "Runtime frame is too large" };
  }
  const decoded = safeJson(buffer.toString("utf8"));
  const envelope = RuntimeFrameEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    return { ok: false, message: "The server sent an invalid runtime frame", reason: "Invalid server frame" };
  }
  return { ok: true, decoded, envelope: envelope.data };
}

export function isValidV2RegistrationFrame(
  frame: Extract<ServerRuntimeFrame, { type: "computer:register:result" }>,
  expectedNegotiatedCapabilities: RuntimeNegotiatedCapabilities | undefined,
): frame is Extract<ServerRuntimeFrame, { type: "computer:register:result"; protocolVersion: 2 }> & {
  connectionId: string;
  negotiatedCapabilities: RuntimeNegotiatedCapabilities;
} {
  if (!("protocolVersion" in frame) || frame.protocolVersion !== RUNTIME_PROTOCOL_V2) {
    return false;
  }
  if (!frame.connectionId || !frame.negotiatedCapabilities || !expectedNegotiatedCapabilities) {
    return false;
  }
  return runtimeNegotiatedCapabilitiesEqual(frame.negotiatedCapabilities, expectedNegotiatedCapabilities);
}

export function hasStaleHeartbeatFence(
  protocolVersion: RuntimeProtocolVersion,
  frame: Extract<ServerRuntimeFrame, { type: "heartbeat:result" }>,
  connectionId: string | undefined,
): boolean {
  if (protocolVersion === RUNTIME_PROTOCOL_V2) {
    return (
      !("protocolVersion" in frame) ||
      frame.protocolVersion !== RUNTIME_PROTOCOL_V2 ||
      frame.connectionId !== connectionId
    );
  }
  return "protocolVersion" in frame;
}
