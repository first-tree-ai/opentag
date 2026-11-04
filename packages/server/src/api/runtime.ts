import { HTTP_PATHS, negotiateProviderReadinessFromHeaders } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createServiceLoggerPort, type PerformanceLogger } from "../observability/index.js";
import type { AgentRuntimeOptionsOwner } from "../runtime/agent-runtime-options-owner.js";
import type { AgentRuntimeTestOwner } from "../runtime/agent-runtime-test-owner.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { ProviderCliReconcileOwner } from "../runtime/provider-cli-reconcile-owner.js";
import type { RuntimeDomainOwner } from "../runtime/runtime-domain-owner.js";
import {
  type RuntimeBusinessOptions,
  type RuntimeServerBusinessFrame,
  RuntimeSession,
  type RuntimeSessionOptions,
} from "../runtime/runtime-session.js";
import type { SlackAutoSetupOwner } from "../runtime/slack-auto-setup-owner.js";
import type { ComputerAuthVerifier, ComputerService } from "../services/computers/index.js";
import { SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS } from "../services/runtime-config/index.js";
import { startClosingServerResources } from "../shutdown.js";

export interface RuntimeRoutesOptions extends RuntimeSessionOptions {
  approvalOwner?: {
    businessOptions(): RuntimeBusinessOptions;
    close(): void | Promise<void>;
  };
  agentRuntimeOptionsOwner?: AgentRuntimeOptionsOwner;
  agentRuntimeTestOwner?: AgentRuntimeTestOwner;
  slackAutoSetupOwner?: SlackAutoSetupOwner;
  domainOwner?: RuntimeDomainOwner;
  providerCliReconcileOwner?: ProviderCliReconcileOwner;
  registry?: ConnectionRegistry;
  runtimeCredentialOwner?: { businessOptions(): RuntimeBusinessOptions };
  performanceLogger?: PerformanceLogger;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function buildRuntimeFrameTraceInput(
  frame: RuntimeServerBusinessFrame,
  computerId: string,
): Parameters<PerformanceLogger["traceOperation"]>[0] {
  const requestId = stringField(frame, "requestId");
  const agentId = stringField(frame, "agentId");
  const sessionId = stringField(frame, "sessionId");
  const deliveryId = stringField(frame, "deliveryId");
  return {
    module: "ws",
    category: "ws",
    operation: `runtime.ws.frame ${frame.type}`,
    ...(requestId ? { requestId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    computerId,
    attributes: { frameType: frame.type },
  };
}

function wrapRuntimeBusinessWithPerformance(
  business: RuntimeBusinessOptions | undefined,
  perfLogger: PerformanceLogger | undefined,
): RuntimeBusinessOptions | undefined {
  if (!business || !perfLogger) return business;
  return {
    ...business,
    handle: (frame, context) =>
      perfLogger.traceOperation(
        buildRuntimeFrameTraceInput(frame, context.computerId),
        () => business.handle(frame, context),
        { fallbackErrorCode: "RUNTIME_FRAME_FAILED" },
      ),
  };
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
  const logger = options.logger ?? createServiceLoggerPort(() => app.log, "runtime-session");
  const registry = options.registry ?? new ConnectionRegistry({ logger });
  const domainOwner = options.domainOwner;
  const agentRuntimeTestOwner = options.agentRuntimeTestOwner;
  const providerCliReconcileOwner = options.providerCliReconcileOwner;
  const sessions = new Set<RuntimeSession>();
  const composedBusiness =
    options.business ??
    composeRuntimeBusinessOptions(
      options.approvalOwner?.businessOptions(),
      providerCliReconcileOwner?.businessOptions(),
      agentRuntimeTestOwner?.businessOptions(),
      options.slackAutoSetupOwner?.businessOptions(),
      options.agentRuntimeOptionsOwner?.businessOptions(),
      domainOwner?.businessOptions(),
      options.runtimeCredentialOwner?.businessOptions(),
    );
  const sessionOptions: RuntimeSessionOptions = {
    authTimeoutMs: options.authTimeoutMs,
    business: wrapRuntimeBusinessWithPerformance(composedBusiness, options.performanceLogger),
    channelTarget: options.channelTarget,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    logger,
    now: options.now,
    onRegistered: async (input) => {
      await options.onRegistered?.(input);
      await providerCliReconcileOwner?.onComputerRegistered(input);
    },
    registerTimeoutMs: options.registerTimeoutMs,
  };
  app.get(HTTP_PATHS.computerRuntimeWebSocket, { websocket: true }, (socket, request) => {
    const providerReadiness = negotiateProviderReadinessFromHeaders(
      request.headers,
      SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS,
    );
    const session = new RuntimeSession(socket, machineAuth, computerService, registry, {
      ...sessionOptions,
      providerReadiness: providerReadiness?.providers,
      providerReadinessVersion: providerReadiness?.version,
    });
    sessions.add(session);
    session.start();
    socket.once("close", () => {
      void session.close().then(
        () => sessions.delete(session),
        () => sessions.delete(session),
      );
    });
  });
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - heartbeatTimeoutMs;
      registry.terminateStale(cutoff, (count) =>
        logger.warn({ count, cutoff }, "Stale runtime connection sweep terminated connections"),
      );
    },
    Math.min(5_000, heartbeatTimeoutMs),
  );
  sweep.unref();
  let closing: Promise<void> | undefined;
  const beginClose = () => {
    if (closing) return closing;
    clearInterval(sweep);
    closing = startClosingServerResources([
      ["Runtime approvals", () => options.approvalOwner?.close()],
      ["Runtime tests", () => agentRuntimeTestOwner?.close()],
      ["Slack setup requests", () => options.slackAutoSetupOwner?.close()],
      ["Runtime options", () => options.agentRuntimeOptionsOwner?.close()],
      ["Provider preparation", () => providerCliReconcileOwner?.close()],
      ["Runtime Domain", () => domainOwner?.close()],
      ["Runtime connection registry", () => registry.closeAll()],
      ...[...sessions].map((session) => ["Runtime session", () => session.close()] as const),
    ]);
    void closing.catch(() => undefined);
    return closing;
  };
  app.addHook("preClose", async () => {
    void beginClose();
  });
  app.addHook("onClose", () => beginClose());
  return registry;
}
