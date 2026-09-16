import { randomUUID } from "node:crypto";
import {
  negotiateRuntimeCapabilities,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import type { WebSocket } from "ws";

export function completeAuth(
  socket: WebSocket,
  frame: Record<string, unknown>,
  providerReadiness: boolean | readonly string[] = false,
): void {
  socket.send(
    JSON.stringify({
      type: "auth:result",
      requestId: frame.requestId,
      ok: true,
      computerId: randomUUID(),
      installationId: randomUUID(),
    }),
  );
  const providers = Array.isArray(providerReadiness) ? providerReadiness : providerReadiness ? ["codex"] : undefined;
  socket.send(
    JSON.stringify({
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
      supportedCapabilities: RUNTIME_SERVER_CAPABILITY_OFFERS,
      requiredClientCapabilities: [],
      ...(providers ? { providerReadiness: { version: 1, providers } } : {}),
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 1_000,
    }),
  );
}

export function registrationResult(frame: Record<string, unknown>, connectionId = randomUUID()) {
  return {
    type: "computer:register:result",
    requestId: frame.requestId,
    ok: true,
    protocolVersion: RUNTIME_PROTOCOL_V2,
    connectionId,
    negotiatedCapabilities: negotiateRuntimeCapabilities(
      RUNTIME_CLIENT_CAPABILITY_OFFERS,
      RUNTIME_SERVER_CAPABILITY_OFFERS,
    ),
  };
}

export function heartbeatResult(frame: Record<string, unknown>) {
  return {
    type: "heartbeat:result",
    requestId: frame.requestId,
    ok: true,
    protocolVersion: RUNTIME_PROTOCOL_V2,
    connectionId: frame.connectionId,
    serverTime: new Date().toISOString(),
  };
}
