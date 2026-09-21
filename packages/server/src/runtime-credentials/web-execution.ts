import type { RuntimeWebServiceScope, WebToolErrorCode } from "@opentag/shared";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeConnectionFence } from "./credential-broker.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeFenceViolation, RuntimeScopeResolverPort } from "./scope-resolver.js";
import type { RuntimeExecutionRecord } from "./types.js";

/** Bounded, redacted web failure. The HTTP routes map `code` to a status; nothing else leaks. */
export class RuntimeWebError extends Error {
  readonly retryable?: boolean;

  constructor(
    readonly code: WebToolErrorCode,
    message: string,
    options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = "RuntimeWebError";
    if (options?.retryable !== undefined) this.retryable = options.retryable;
  }
}

export interface RuntimeWebExecutionAuthorizerOptions {
  executions: RuntimeExecutionRegistry;
  scopeResolver: RuntimeScopeResolverPort;
  /** Accepted-custody / collaboration revalidation; required so no composition omits it. */
  authority: RuntimeExecutionAuthority;
  /** Exact current control connection; required so no composition omits the fence. */
  connectionFence: RuntimeConnectionFence;
  /** Live Cloud control credential check; Cloud web requests fail closed when missing/denied. */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
}

function fenceViolationError(violation: RuntimeFenceViolation): RuntimeWebError {
  switch (violation) {
    case "session_unknown":
      return new RuntimeWebError("execution_unknown", "The execution Session is unknown");
    case "session_ended":
    case "session_internal":
      return new RuntimeWebError("execution_closed", "The execution Session is closed");
    case "binding_inactive":
    case "installation_inactive":
    case "ownership_mismatch":
      return new RuntimeWebError("credential_scope_denied", "The execution ownership fence changed");
    default:
      // placement_stale / agent_mismatch / agent_inactive / agent_revision_changed / sandbox_mismatch:
      // a stale generation or replaced owner can never keep using the execution.
      return new RuntimeWebError("execution_closed", "The execution fence is stale");
  }
}

/**
 * Authoritative per-request fence for the two fixed web routes. Re-checks the live execution,
 * the exact control connection, the Cloud control credential, the accepted admission source, and
 * a fresh DB Session/sandbox snapshot on every call — before dispatch and again before delivery.
 * Identity comes only from the execution record and the authenticated Computer; request body
 * identity fields are fence inputs (executionId), never authorization claims.
 */
export class RuntimeWebExecutionAuthorizer {
  readonly #options: RuntimeWebExecutionAuthorizerOptions;

  constructor(options: RuntimeWebExecutionAuthorizerOptions) {
    this.#options = options;
  }

  async authorize(input: {
    executionId: string;
    computerId: string;
    scope: RuntimeWebServiceScope;
    signal?: AbortSignal;
  }): Promise<RuntimeExecutionRecord> {
    input.signal?.throwIfAborted();
    const execution = this.#options.executions.get(input.executionId);
    // A foreign or absent execution is indistinguishable from unknown: no existence leaks.
    if (!execution || execution.computerId !== input.computerId) {
      throw new RuntimeWebError("execution_unknown", "The execution is unknown");
    }
    // Validation-purpose executions carry read-only identity scope and never authorize web calls.
    if (execution.purpose !== "execution") {
      throw new RuntimeWebError("execution_closed", "The execution cannot authorize web calls");
    }
    const granted = execution.services?.some(
      (service) => service.service === "web" && service.scopes.includes(input.scope),
    );
    if (!granted) {
      throw new RuntimeWebError("credential_scope_denied", "The execution has no web service scope");
    }
    if (!this.#options.connectionFence.isCurrent(execution.computerId, execution.instanceId, execution.connectionId)) {
      throw new RuntimeWebError("execution_closed", "The execution control connection was replaced");
    }
    if (execution.computerKind === "cloud") {
      const identity = this.#options.connectionFence?.currentControlIdentity?.(execution.computerId);
      if (identity?.kind !== "cloud" || identity.computerId !== execution.computerId) {
        throw new RuntimeWebError("execution_closed", "The Cloud control connection was replaced");
      }
      if ((await this.#options.cloudControlActive?.(identity)) !== true) {
        throw new RuntimeWebError("execution_closed", "The Cloud control credential is no longer active");
      }
    }
    const revalidation = await this.#options.authority.revalidate(execution.source, {
      sessionId: execution.sessionId,
      agentId: execution.agentId,
      computerId: execution.computerId,
      instanceId: execution.instanceId,
    });
    if (revalidation === "invalid") {
      throw new RuntimeWebError("execution_closed", "The execution admission source was released");
    }
    if (revalidation === "not_ready") {
      throw new RuntimeWebError("execution_unknown", "The execution admission source is not ready");
    }
    const snapshot = await this.#options.scopeResolver.load(execution.sessionId);
    if (!snapshot) throw new RuntimeWebError("execution_unknown", "The execution Session is unknown");
    const violation = this.#options.scopeResolver.assertExecutionFence(execution, snapshot);
    if (violation) throw fenceViolationError(violation);
    input.signal?.throwIfAborted();
    return execution;
  }
}
