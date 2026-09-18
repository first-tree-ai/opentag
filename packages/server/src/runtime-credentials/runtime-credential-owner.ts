import {
  RUNTIME_CAPABILITY,
  type RuntimeCredentialClientFrame,
  RuntimeCredentialClientFrameSchema,
  type RuntimeCredentialProvider,
  type RuntimeCredentialRejectCode,
  type RuntimeCredentialResult,
  type RuntimeCredentialRevokedCode,
  type RuntimeCredentialServerFrame,
  type RuntimeExecutionOpenRejectCode,
  type RuntimeExecutionOpenResult,
  type RuntimeProxyTicketResult,
} from "@opentag/shared";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { ConnectionRegistry, RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "../runtime/runtime-session.js";
import type { RuntimeCapabilityStore } from "./capability-store.js";
import {
  type RuntimeControlAuthority,
  type RuntimeCredentialBroker,
  RuntimeCredentialError,
} from "./credential-broker.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeGitHubAdmission } from "./github-admission.js";
import { openRuntimeSessionExecution } from "./runtime-session-execution.js";
import { issueRuntimeValidationRun, openRuntimeValidationExecution } from "./runtime-validation-execution.js";
import type { RuntimeScopeResolverPort } from "./scope-resolver.js";
import type { RuntimeTaskPolicy } from "./task-policy.js";
import type { RuntimeProxyTicketStore } from "./ticket-store.js";
import type { RuntimeExecutionRecord } from "./types.js";
import type { RuntimeValidationRunRegistry } from "./validation-runs.js";
import type { RuntimeWebServicePolicy } from "./web-policy.js";

export { VALIDATION_EXECUTION_MAX_LIFETIME_MS } from "./runtime-validation-execution.js";

export interface RuntimeCredentialOwnerOptions {
  registry: ConnectionRegistry;
  /**
   * Composed Local + Cloud control-connection authority. Defaults to the Local registry alone.
   * The owner sweep, exact execution fence, and revocation notification all consult this one port,
   * so a live Cloud execution is never revoked by the Local registry's absence and a Cloud
   * revocation is routed to the exact owning connection.
   */
  controlAuthority?: RuntimeControlAuthority;
  executions: RuntimeExecutionRegistry;
  capabilities: RuntimeCapabilityStore;
  tickets: RuntimeProxyTicketStore;
  validationRuns: RuntimeValidationRunRegistry;
  authority: RuntimeExecutionAuthority;
  scopeResolver: RuntimeScopeResolverPort;
  broker: RuntimeCredentialBroker;
  policy: RuntimeTaskPolicy;
  gitHubAdmission: RuntimeGitHubAdmission;
  /** Live Cloud control credential check; Cloud open fails closed when missing or denied. */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
  /** Deployment web service policy; absent keeps the web service fully off at execution open. */
  webPolicy?: RuntimeWebServicePolicy;
  logger?: ServiceLogger;
  sweepIntervalMs?: number;
}

/**
 * Control-plane owner for runtime credential delegation. Handles execution open/acquire/renew/
 * close/ticket over the authenticated business channel, drops executions whose control connection
 * is replaced or closed (best-effort revoke notification; Server-local invalidation is the
 * authority), and never infers execution lifetime from a missing report.
 */
export class RuntimeCredentialOwner {
  readonly #options: RuntimeCredentialOwnerOptions;
  readonly #logger?: ServiceLogger;
  readonly #authority: RuntimeControlAuthority;
  readonly #sweep: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: RuntimeCredentialOwnerOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#authority = options.controlAuthority ?? registryControlAuthority(options.registry);
    this.#sweep = setInterval(() => this.#sweepStale(), options.sweepIntervalMs ?? 5_000);
    this.#sweep.unref?.();
  }

  get validation(): RuntimeValidationRunRegistry {
    return this.#options.validationRuns;
  }

  get executionRegistry(): RuntimeExecutionRegistry {
    return this.#options.executions;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweep);
    // Destroying the owner revokes every grant and aborts every stream via close events.
    for (const record of this.#options.executions.executions()) {
      this.#revokeExecution(record.executionId, "owner_lost", false);
    }
  }

  /**
   * Close every execution bound to one exact control connection (replacement or channel close).
   * Server-local invalidation is the authority; notification is best effort.
   */
  closeConnection(connectionId: string, code: RuntimeCredentialRevokedCode): string[] {
    const closed: string[] = [];
    for (const record of this.#options.executions.executions()) {
      if (record.connectionId !== connectionId) continue;
      this.#revokeExecution(record.executionId, code, false);
      closed.push(record.executionId);
    }
    return closed;
  }

  /** Close every execution opened for one Session; used by an explicit Cloud stop. */
  closeSessionExecutions(sessionId: string, code: RuntimeCredentialRevokedCode): string[] {
    const closed: string[] = [];
    for (const record of this.#options.executions.executions()) {
      if (record.sessionId !== sessionId) continue;
      this.#revokeExecution(record.executionId, code, false);
      closed.push(record.executionId);
    }
    return closed;
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = RuntimeCredentialClientFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => {
        const parsed = RuntimeCredentialClientFrameSchema.parse(frame);
        return `runtime-credential:${"executionId" in parsed ? parsed.executionId : parsed.sessionId}`;
      },
      handle: (frame, context) => this.handle(frame as RuntimeCredentialClientFrame, context),
      failureResult: (frame) => this.#failureResult(frame),
      overloadResult: (frame) => this.#failureResult(frame),
      maxConcurrent: 32,
      maxQueuedPerKey: 32,
      maxQueuedTotal: 1024,
    };
  }

  async handle(
    frame: RuntimeCredentialClientFrame,
    context: RuntimeBusinessContext,
  ): Promise<RuntimeCredentialServerFrame | undefined> {
    if (this.#closed) return this.#failureResult(frame);
    if (frame.type === "runtime:execution:open") return this.#open(frame, context);
    if (frame.type === "runtime:credential:acquire") return this.#acquire(frame, context);
    if (frame.type === "runtime:credential:renew") return this.#renew(frame, context);
    if (frame.type === "runtime:execution:close") return this.#closeExecution(frame, context);
    return this.#ticket(frame, context);
  }

  async #open(
    frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>,
    context: RuntimeBusinessContext,
  ): Promise<RuntimeExecutionOpenResult> {
    const rejected = (code: RuntimeExecutionOpenRejectCode): RuntimeExecutionOpenResult => ({
      type: "runtime:execution:result",
      requestId: frame.requestId,
      status: "rejected",
      code,
    });
    if (context.negotiatedCapabilities?.[RUNTIME_CAPABILITY.runtimeCredential] !== 1 || !context.connectionId) {
      return rejected("capability_unsupported");
    }
    // Exact connection fence: the opening frame must come from the connection that is current for
    // this instance right now. Local and Cloud share this one check through the composed port.
    if (!this.#authority.isCurrentConnection(context.computerId, context.instanceId, context.connectionId)) {
      return rejected("placement_stale");
    }
    if (frame.source.kind === "validation") return this.#openValidation(frame, context);
    return openRuntimeSessionExecution(this.#sessionDeps(), frame, context);
  }

  /** Open functions consume the composed authority, never the raw Local registry. */
  #sessionDeps(): Omit<RuntimeCredentialOwnerOptions, "registry"> & { registry: RuntimeControlAuthority } {
    return { ...this.#options, registry: this.#authority };
  }

  async #openValidation(
    frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>,
    context: RuntimeBusinessContext,
  ): Promise<RuntimeExecutionOpenResult> {
    return openRuntimeValidationExecution(this.#sessionDeps(), frame, context);
  }

  /**
   * Issues the Server-side validation run that authorizes one isolated read-only validation
   * execution. Only an authoritative binding/agent/computer fence produces a run; unknown or
   * inactive facts return `undefined` and no run exists.
   */
  async issueValidationRun(input: {
    provider: RuntimeCredentialProvider;
    bindingId: string;
    agentId: string;
    computerId: string;
    instanceId: string;
    connectionId?: string;
  }): Promise<{ validationRunId: string; expiresAt: number } | undefined> {
    return issueRuntimeValidationRun(this.#sessionDeps(), input);
  }

  async #acquire(
    frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:credential:acquire" }>,
    context: RuntimeBusinessContext,
  ): Promise<RuntimeCredentialResult> {
    const execution = this.#contextExecution(frame.executionId, context);
    if (!execution) return credentialRejected(frame.requestId, "execution_unknown");
    try {
      const outcome = await this.#options.broker.acquire({
        execution,
        provider: frame.provider,
        bindingId: frame.bindingId,
        signal: context.signal,
      });
      return grantOutcome(frame.requestId, outcome);
    } catch (error) {
      if (error instanceof RuntimeCredentialError) return credentialRejected(frame.requestId, error.code);
      return credentialRejected(frame.requestId, "owner_unavailable");
    }
  }

  async #renew(
    frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:credential:renew" }>,
    context: RuntimeBusinessContext,
  ): Promise<RuntimeCredentialResult> {
    const execution = this.#contextExecution(frame.executionId, context);
    if (!execution) return credentialRejected(frame.requestId, "execution_unknown");
    try {
      const outcome = await this.#options.broker.renew({
        execution,
        grantId: frame.grantId,
        signal: context.signal,
      });
      return grantOutcome(frame.requestId, outcome);
    } catch (error) {
      if (error instanceof RuntimeCredentialError) return credentialRejected(frame.requestId, error.code);
      return credentialRejected(frame.requestId, "owner_unavailable");
    }
  }

  #closeExecution(
    frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:close" }>,
    context: RuntimeBusinessContext,
  ): RuntimeCredentialServerFrame {
    const execution = this.#contextExecution(frame.executionId, context);
    if (!execution) {
      return {
        type: "runtime:execution:closed",
        requestId: frame.requestId,
        executionId: frame.executionId,
        status: "rejected",
        code: "execution_unknown",
      };
    }
    this.#revokeExecution(execution.executionId, "execution_closed", false);
    return {
      type: "runtime:execution:closed",
      requestId: frame.requestId,
      executionId: frame.executionId,
      status: "succeeded",
    };
  }

  #ticket(
    frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:proxy:ticket" }>,
    context: RuntimeBusinessContext,
  ): RuntimeProxyTicketResult {
    const rejected = (
      code: "execution_unknown" | "execution_closed" | "capability_unsupported" | "owner_unavailable",
    ) =>
      ({
        type: "runtime:proxy:ticket:result",
        requestId: frame.requestId,
        status: "rejected",
        code,
      }) satisfies RuntimeProxyTicketResult;
    if (context.negotiatedCapabilities?.[RUNTIME_CAPABILITY.providerProxy] !== 1 || !context.connectionId) {
      return rejected("capability_unsupported");
    }
    const execution = this.#contextExecution(frame.executionId, context);
    if (!execution) return rejected("execution_unknown");
    try {
      const { ticket, expiresAt } = this.#options.tickets.issue({
        executionId: execution.executionId,
        computerId: execution.computerId,
        instanceId: execution.instanceId,
        connectionId: execution.connectionId,
      });
      return {
        type: "runtime:proxy:ticket:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: execution.executionId,
        ticket,
        expiresAt: new Date(expiresAt).toISOString(),
        path: "/api/v1/runtime/provider-proxy",
      };
    } catch {
      return rejected("owner_unavailable");
    }
  }

  /** Executions are only reachable through the exact control connection that opened them. */
  #contextExecution(executionId: string, context: RuntimeBusinessContext): RuntimeExecutionRecord | undefined {
    const record = this.#options.executions.get(executionId);
    if (
      !record ||
      record.computerId !== context.computerId ||
      record.instanceId !== context.instanceId ||
      record.connectionId !== context.connectionId ||
      !this.#authority.isCurrentConnection(record.computerId, record.instanceId, record.connectionId)
    ) {
      return undefined;
    }
    return record;
  }

  #revokeExecution(executionId: string, code: RuntimeCredentialRevokedCode, notify: boolean): void {
    const record = this.#options.executions.close(executionId, code);
    if (!record) return;
    this.#options.capabilities.revokeExecution(executionId);
    this.#options.tickets.revokeExecution(executionId);
    if (!notify) return;
    const frame: RuntimeCredentialServerFrame = { type: "runtime:credential:revoked", executionId, code };
    try {
      const sending = this.#authority.sendRevoked
        ? this.#authority.sendRevoked(record.computerId, record.instanceId, frame)
        : this.#options.registry.send(record.computerId, record.instanceId, frame);
      void Promise.resolve(sending).catch(() => undefined);
    } catch {
      // A failed revocation notification never resurrects the Server-local invalidation above.
    }
  }

  /** Public maintenance seam for tests and explicit maintenance runs; idempotent. */
  sweepNow(): void {
    this.#sweepStale();
  }

  #sweepStale(): void {
    if (this.#closed) return;
    this.#options.executions.sweep();
    this.#options.capabilities.sweep();
    this.#options.tickets.sweep();
    this.#options.validationRuns.sweep();
    for (const record of this.#options.executions.executions()) {
      if (!this.#authority.isCurrentConnection(record.computerId, record.instanceId, record.connectionId)) {
        this.#revokeExecution(record.executionId, "connection_replaced", true);
      }
    }
  }

  #failureResult(frame: unknown): RuntimeCredentialServerFrame | undefined {
    const parsed = RuntimeCredentialClientFrameSchema.safeParse(frame);
    if (!parsed.success) return undefined;
    const data = parsed.data;
    try {
      this.#logger?.warn(
        { code: "RUNTIME_CREDENTIAL_OWNER_UNAVAILABLE", frameType: data.type },
        "Runtime credential request failed",
      );
    } catch {
      // Logging must never replace the failure result.
    }
    if (data.type === "runtime:execution:open") {
      return {
        type: "runtime:execution:result",
        requestId: data.requestId,
        status: "rejected",
        code: "owner_unavailable",
      };
    }
    if (data.type === "runtime:credential:acquire" || data.type === "runtime:credential:renew") {
      return credentialRejected(data.requestId, "owner_unavailable");
    }
    if (data.type === "runtime:execution:close") {
      return {
        type: "runtime:execution:closed",
        requestId: data.requestId,
        executionId: data.executionId,
        status: "rejected",
        code: "owner_unavailable",
      };
    }
    return {
      type: "runtime:proxy:ticket:result",
      requestId: data.requestId,
      status: "rejected",
      code: "owner_unavailable",
    };
  }
}

function credentialRejected(requestId: string, code: RuntimeCredentialRejectCode): RuntimeCredentialResult {
  return { type: "runtime:credential:result", requestId, status: "rejected", code };
}

function registryControlAuthority(registry: ConnectionRegistry): RuntimeControlAuthority {
  return {
    isCurrentConnection: (computerId, instanceId, connectionId) =>
      registry.isCurrentConnection(computerId, instanceId, connectionId),
    currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
    currentControlIdentity: (computerId) => registry.currentControlIdentity(computerId),
  };
}

function grantOutcome(
  requestId: string,
  outcome: Awaited<ReturnType<RuntimeCredentialBroker["acquire"]>>,
): RuntimeCredentialResult {
  if (outcome.status === "rejected") return credentialRejected(requestId, outcome.code);
  return {
    type: "runtime:credential:result",
    requestId,
    status: "succeeded",
    executionId: outcome.record.executionId,
    grantId: outcome.record.grantId,
    provider: outcome.record.provider,
    bindingId: outcome.record.bindingId,
    opaqueToken: outcome.token,
    expiresAt: new Date(outcome.record.expiresAt).toISOString(),
    refreshAfter: new Date(outcome.record.refreshAfter).toISOString(),
    scopeHash: outcome.record.scopeHash,
    authorizationRevision: outcome.record.authorizationRevision,
    credentialGeneration: outcome.record.credentialGeneration,
    cli: outcome.cli,
  };
}
