import { HTTP_PATHS } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import {
  RUNNER_WS_DEFAULT_HEARTBEAT_INTERVAL_MS,
  RUNNER_WS_DEFAULT_HEARTBEAT_TIMEOUT_MS,
  RunnerConnection,
  type RunnerWebSocketRouteOptions,
} from "./runner-connection.js";

export type { RunnerWebSocketRouteOptions } from "./runner-connection.js";

/**
 * Runner control channel registration. Runners dial OUT from their Cloud Run Instance to this
 * route; authentication, per-connection state, and frame handling live in `RunnerConnection`.
 * The route owns only the shared liveness sweeps and their shutdown.
 */
export function registerRunnerWebSocketRoute(app: FastifyInstance, options: RunnerWebSocketRouteOptions): void {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? RUNNER_WS_DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? RUNNER_WS_DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  app.get(HTTP_PATHS.sandboxRunnerWebSocket, { websocket: true }, (socket, request) => {
    new RunnerConnection({ socket, request, options, now }).start();
  });

  const sweep = setInterval(() => {
    options.hub.sweepStale(now() - heartbeatTimeoutMs);
  }, heartbeatTimeoutMs);
  sweep.unref();
  const heartbeat = setInterval(() => {
    options.hub.heartbeatAll({ type: "server:heartbeat" });
  }, heartbeatIntervalMs);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweep);
    clearInterval(heartbeat);
  });
}
