import { HTTP_PATHS, PROVIDER_READINESS_V1_HEADER } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { AgentRuntimeTestOwner } from "../runtime/agent-runtime-test-owner.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { ProviderCliReconcileOwner } from "../runtime/provider-cli-reconcile-owner.js";
import type { RuntimeDomainOwner } from "../runtime/runtime-domain-owner.js";
import { type RuntimeBusinessOptions, RuntimeSession, type RuntimeSessionOptions } from "../runtime/runtime-session.js";
import type { ComputerAuthVerifier, ComputerService } from "../services/computers/index.js";
import { SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS } from "../services/runtime-config/index.js";

export interface RuntimeRoutesOptions extends RuntimeSessionOptions {
  agentRuntimeTestOwner?: AgentRuntimeTestOwner;
  domainOwner?: RuntimeDomainOwner;
  providerCliReconcileOwner?: ProviderCliReconcileOwner;
  registry?: ConnectionRegistry;
}

export function composeRuntimeBusinessOptions(
  ...owners: Array<RuntimeBusinessOptions | undefined>
): RuntimeBusinessOptions | undefined {
  const active = owners.filter((owner): owner is RuntimeBusinessOptions => owner !== undefined);
  if (active.length === 0) return undefined;
  const [first, ...rest] = active;
  if (!first || rest.length === 0) return first;
  return {
    parse: (input) => {
      for (const owner of active) {
        const parsed = owner.parse(input);
        if (parsed) return parsed;
      }
      return undefined;
    },
    laneKey: (frame) => {
      for (const owner of active) {
        if (owner.parse(frame)) return owner.laneKey(frame);
      }
      return first.laneKey(frame);
    },
    handle: (frame, context) => {
      for (const owner of active) {
        if (owner.parse(frame)) return owner.handle(frame, context);
      }
      return first.handle(frame, context);
    },
    failureResult: (frame) => {
      for (const owner of active) {
        if (owner.parse(frame)) return owner.failureResult(frame);
      }
      return first.failureResult(frame);
    },
    overloadResult: (frame) => {
      for (const owner of active) {
        if (owner.parse(frame)) return owner.overloadResult(frame);
      }
      return first.overloadResult(frame);
    },
    maxConcurrent: Math.min(...active.map((owner) => owner.maxConcurrent ?? 32)),
    maxQueuedPerKey: Math.min(...active.map((owner) => owner.maxQueuedPerKey ?? 32)),
    maxQueuedTotal: Math.min(...active.map((owner) => owner.maxQueuedTotal ?? 1024)),
  };
}

export function registerRuntimeRoutes(
  app: FastifyInstance,
  machineAuth: ComputerAuthVerifier,
  computerService: ComputerService,
  options: RuntimeRoutesOptions = {},
): ConnectionRegistry {
  const registry = options.registry ?? new ConnectionRegistry();
  const domainOwner = options.domainOwner;
  const agentRuntimeTestOwner = options.agentRuntimeTestOwner;
  const providerCliReconcileOwner = options.providerCliReconcileOwner;
  const sessionOptions: RuntimeSessionOptions = {
    authTimeoutMs: options.authTimeoutMs,
    business:
      options.business ??
      composeRuntimeBusinessOptions(
        providerCliReconcileOwner?.businessOptions(),
        agentRuntimeTestOwner?.businessOptions(),
        domainOwner?.businessOptions(),
      ),
    channelTarget: options.channelTarget,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    now: options.now,
    onRegistered: async (input) => {
      await options.onRegistered?.(input);
      await providerCliReconcileOwner?.onComputerRegistered(input);
    },
    registerTimeoutMs: options.registerTimeoutMs,
  };
  app.get(HTTP_PATHS.computerRuntimeWebSocket, { websocket: true }, (socket, request) => {
    new RuntimeSession(socket, machineAuth, computerService, registry, {
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
    agentRuntimeTestOwner?.close();
    providerCliReconcileOwner?.close();
    domainOwner?.close();
    registry.closeAll();
  });
  return registry;
}
