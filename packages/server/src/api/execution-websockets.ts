import websocket from "@fastify/websocket";
import { RUNNER_WS_MAX_FRAME_BYTES, RUNTIME_MAX_FRAME_BYTES } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { CreateAppOptions } from "../app.js";
import { registerRunnerWebSocketRoute } from "./runner-ws.js";
import { registerRuntimeRoutes } from "./runtime.js";

type ExecutionOptions = Pick<
  CreateAppOptions,
  "computerService" | "machineAuthService" | "runtime" | "runnerChannel" | "sandboxRunnerService"
>;

/** One HTTP upgrade listener serves both protocols. Each route keeps its own auth and frame bound. */
export function registerExecutionWebSocketRoutes(app: FastifyInstance, options: ExecutionOptions): void {
  const local = options.computerService && options.machineAuthService;
  const runner = options.runnerChannel && options.sandboxRunnerService;
  if (!local && !runner) return;
  app.register(async (channelApp) => {
    // RuntimeSession rejects >64 KiB before parsing. Runner frames need the larger transport
    // bound; registering the websocket plugin twice installs duplicate HTTP upgrade listeners.
    await channelApp.register(websocket, {
      options: { maxPayload: runner ? RUNNER_WS_MAX_FRAME_BYTES : RUNTIME_MAX_FRAME_BYTES },
    });
    if (options.computerService && options.machineAuthService) {
      registerRuntimeRoutes(channelApp, options.machineAuthService, options.computerService, options.runtime);
    }
    if (options.runnerChannel && options.sandboxRunnerService) {
      registerRunnerWebSocketRoute(channelApp, {
        ...options.runnerChannel,
        service: options.sandboxRunnerService,
      });
    }
  });
}
