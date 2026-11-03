import { HTTP_PATHS } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { startClosingServerResources } from "../shutdown.js";
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
 * The route owns live connections and the shared liveness sweeps.
 */
export function registerRunnerWebSocketRoute(app: FastifyInstance, options: RunnerWebSocketRouteOptions): void {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? RUNNER_WS_DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? RUNNER_WS_DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const connections = new Set<RunnerConnection>();

  app.get(HTTP_PATHS.sandboxRunnerWebSocket, { websocket: true }, (socket, request) => {
    const connection = new RunnerConnection({ socket, request, options, now });
    connections.add(connection);
    connection.start();
    socket.once("close", () => {
      void connection.close().then(
        () => connections.delete(connection),
        () => connections.delete(connection),
      );
    });
  });

  const sweep = setInterval(() => {
    options.hub.sweepStale(now() - heartbeatTimeoutMs);
  }, heartbeatTimeoutMs);
  sweep.unref();
  const heartbeat = setInterval(() => {
    options.hub.heartbeatAll({ type: "server:heartbeat" });
  }, heartbeatIntervalMs);
  heartbeat.unref();
  let closing: Promise<void> | undefined;
  const beginClose = () => {
    if (closing) return closing;
    clearInterval(sweep);
    clearInterval(heartbeat);
    closing = startClosingServerResources(
      [...connections].map((connection) => ["Runner connection", () => connection.close()] as const),
    );
    void closing.catch(() => undefined);
    return closing;
  };
  app.addHook("preClose", async () => {
    void beginClose();
  });
  app.addHook("onClose", () => beginClose());
}
