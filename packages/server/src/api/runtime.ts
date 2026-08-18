import { HTTP_PATHS } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { RuntimeSession, type RuntimeSessionOptions } from "../runtime/runtime-session.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";

export interface RuntimeRoutesOptions extends RuntimeSessionOptions {
  registry?: ConnectionRegistry;
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  computerService: ComputerService,
  options: RuntimeRoutesOptions = {},
): ConnectionRegistry {
  const registry = options.registry ?? new ConnectionRegistry();
  app.get(HTTP_PATHS.computerRuntimeWebSocket, { websocket: true }, (socket) => {
    new RuntimeSession(socket, authService, computerService, registry, options).start();
  });
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
  const sweep = setInterval(() => registry.terminateStale(Date.now() - heartbeatTimeoutMs), heartbeatTimeoutMs);
  sweep.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    registry.closeAll();
  });
  return registry;
}
