import websocket from "@fastify/websocket";
import { PROVIDER_PROXY_MAX_FRAME_BYTES, RUNNER_WS_MAX_FRAME_BYTES, RUNTIME_MAX_FRAME_BYTES } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { CreateAppOptions } from "../app.js";
import { registerRunnerWebSocketRoute } from "./runner-ws.js";
import { registerRuntimeRoutes } from "./runtime.js";
import { registerRuntimeProviderProxyRoutes } from "./runtime-provider-proxy.js";

type ExecutionOptions = Pick<
  CreateAppOptions,
  | "computerService"
  | "machineAuthService"
  | "runtime"
  | "runtimeAuthService"
  | "runtimeProviderProxy"
  | "runnerChannel"
  | "sandboxRunnerService"
>;

/**
 * One HTTP upgrade listener serves every execution protocol. Each route keeps its own auth and
 * frame bound: the shared transport capacity below is only the widest frame any mounted route may
 * legitimately carry, and every tighter per-route bound stays enforced inside the route itself —
 * RuntimeSession rejects >64 KiB before parsing, the Runner control channel bounds frames before
 * JSON parsing, and the provider proxy transport bounds its own header and binary chunk sizes.
 */
export function registerExecutionWebSocketRoutes(app: FastifyInstance, options: ExecutionOptions): void {
  const local = options.computerService && options.machineAuthService;
  const runner = options.runnerChannel && options.sandboxRunnerService;
  const proxy = options.runtimeProviderProxy;
  if (!local && !runner && !proxy) return;
  const budgets: number[] = [];
  if (local) budgets.push(RUNTIME_MAX_FRAME_BYTES);
  if (runner) budgets.push(RUNNER_WS_MAX_FRAME_BYTES);
  if (proxy) budgets.push(PROVIDER_PROXY_MAX_FRAME_BYTES);
  app.register(async (channelApp) => {
    // Registering the websocket plugin twice installs duplicate HTTP upgrade listeners, so one
    // registration carries the widest mounted budget (Runner 256 KiB, one full binary proxy
    // chunk, or the 64 KiB local runtime bound) and routes enforce their own tighter limits.
    await channelApp.register(websocket, { options: { maxPayload: Math.max(...budgets) } });
    if (options.computerService && options.machineAuthService) {
      registerRuntimeRoutes(
        channelApp,
        options.runtimeAuthService ?? options.machineAuthService,
        options.computerService,
        options.runtime,
      );
    }
    if (options.runnerChannel && options.sandboxRunnerService) {
      registerRunnerWebSocketRoute(channelApp, {
        ...options.runnerChannel,
        service: options.sandboxRunnerService,
      });
    }
    if (options.runtimeProviderProxy) {
      registerRuntimeProviderProxyRoutes(channelApp, options.runtimeProviderProxy);
    }
  });
}
