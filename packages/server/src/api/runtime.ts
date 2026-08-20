import { HTTP_PATHS, PROVIDER_READINESS_V1_HEADER } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { RuntimeDomainOwner } from "../runtime/runtime-domain-owner.js";
import { RuntimeSession, type RuntimeSessionOptions } from "../runtime/runtime-session.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";
import { SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS } from "../services/runtime-config/index.js";

export interface RuntimeRoutesOptions extends RuntimeSessionOptions {
  domainOwner?: RuntimeDomainOwner;
  registry?: ConnectionRegistry;
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  computerService: ComputerService,
  options: RuntimeRoutesOptions = {},
): ConnectionRegistry {
  const registry = options.registry ?? new ConnectionRegistry();
  const domainOwner = options.domainOwner;
  const sessionOptions: RuntimeSessionOptions = {
    authTimeoutMs: options.authTimeoutMs,
    business: options.business ?? domainOwner?.businessOptions(),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    now: options.now,
    registerTimeoutMs: options.registerTimeoutMs,
  };
  app.get(HTTP_PATHS.computerRuntimeWebSocket, { websocket: true }, (socket, request) => {
    new RuntimeSession(socket, authService, computerService, registry, {
      ...sessionOptions,
      providerReadiness:
        request.headers[PROVIDER_READINESS_V1_HEADER] === "1" ? SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS : undefined,
    }).start();
  });
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
  const sweep = setInterval(() => registry.terminateStale(Date.now() - heartbeatTimeoutMs), heartbeatTimeoutMs);
  sweep.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    domainOwner?.close();
    registry.closeAll();
  });
  return registry;
}
