import type { McpGatewayErrorCode } from "@opentag/shared";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeConnectionFence } from "./credential-broker.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeFenceViolation, RuntimeScopeResolverPort } from "./scope-resolver.js";
import type { RuntimeExecutionRecord } from "./types.js";

/** Bounded, redacted gateway failure. The route maps `code` to a status; nothing else leaks. */
export class McpGatewayError extends Error {
  constructor(
    readonly code: McpGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpGatewayError";
  }
}

export interface McpGatewayExecutionAuthorizerOptions {
  executions: RuntimeExecutionRegistry;
  scopeResolver: RuntimeScopeResolverPort;
  /** Accepted-custody / collaboration revalidation; required so no composition omits it. */
  authority: RuntimeExecutionAuthority;
  /** Exact current control connection; required so no composition omits the fence. */
  connectionFence: RuntimeConnectionFence;
  /** Live Cloud control credential check; Cloud gateway requests fail closed when missing/denied. */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
}

function fenceViolationError(violation: RuntimeFenceViolation): McpGatewayError {
  switch (violation) {
    case "session_unknown":
      return new McpGatewayError("execution_unknown", "The execution Session is unknown");
    case "session_ended":
    case "session_internal":
      return new McpGatewayError("execution_closed", "The execution Session is closed");
    case "binding_inactive":
    case "installation_inactive":
    case "ownership_mismatch":
      return new McpGatewayError("execution_closed", "The execution ownership fence changed");
    default:
      // placement_stale / agent_mismatch / agent_inactive / agent_revision_changed / sandbox_mismatch:
      // a stale generation or replaced owner can never keep using the execution.
      return new McpGatewayError("execution_closed", "The execution fence is stale");
  }
}

/**
 * Authoritative per-request fence for the MCP gateway route.
 *
 * The bearer a provider CLI presents proves only *which* execution is calling. Everything that
 * follows — which Account, which Agent, and therefore which MCP credentials are in reach — is read
 * from the live execution record, never from the request. That is the whole reason the token store
 * keeps nothing but an execution id: a token cannot assert an identity it does not carry.
 *
 * Re-checked on every call, not once at issue, because the interesting failures all happen mid-turn:
 * the Session ends, the control connection is replaced, the Agent is suspended, the Cloud control
 * credential lapses. A token minted at the start of a turn must stop working the moment any of those
 * becomes true.
 */
export class McpGatewayExecutionAuthorizer {
  readonly #options: McpGatewayExecutionAuthorizerOptions;

  constructor(options: McpGatewayExecutionAuthorizerOptions) {
    this.#options = options;
  }

  async authorize(input: { executionId: string; signal?: AbortSignal }): Promise<RuntimeExecutionRecord> {
    input.signal?.throwIfAborted();
    const execution = this.#options.executions.get(input.executionId);
    if (!execution) throw new McpGatewayError("execution_unknown", "The execution is unknown");
    // Validation-purpose executions carry read-only identity scope and never authorize tool calls.
    if (execution.purpose !== "execution") {
      throw new McpGatewayError("execution_closed", "The execution cannot authorize MCP calls");
    }
    const granted = execution.services?.some(
      (service) => service.service === "mcp" && service.scopes.includes("mcp:tools"),
    );
    if (!granted) throw new McpGatewayError("scope_denied", "The execution has no MCP service scope");
    if (!this.#options.connectionFence.isCurrent(execution.computerId, execution.instanceId, execution.connectionId)) {
      throw new McpGatewayError("execution_closed", "The execution control connection was replaced");
    }
    if (execution.computerKind === "cloud") {
      const identity = this.#options.connectionFence?.currentControlIdentity?.(execution.computerId);
      if (identity?.kind !== "cloud" || identity.computerId !== execution.computerId) {
        throw new McpGatewayError("execution_closed", "The Cloud control connection was replaced");
      }
      if ((await this.#options.cloudControlActive?.(identity)) !== true) {
        throw new McpGatewayError("execution_closed", "The Cloud control credential is no longer active");
      }
    }
    const revalidation = await this.#options.authority.revalidate(execution.source, {
      sessionId: execution.sessionId,
      agentId: execution.agentId,
      computerId: execution.computerId,
      instanceId: execution.instanceId,
    });
    if (revalidation === "invalid") {
      throw new McpGatewayError("execution_closed", "The execution admission source was released");
    }
    if (revalidation === "not_ready") {
      throw new McpGatewayError("execution_unknown", "The execution admission source is not ready");
    }
    const snapshot = await this.#options.scopeResolver.load(execution.sessionId);
    if (!snapshot) throw new McpGatewayError("execution_unknown", "The execution Session is unknown");
    const violation = this.#options.scopeResolver.assertExecutionFence(execution, snapshot);
    if (violation) throw fenceViolationError(violation);
    input.signal?.throwIfAborted();
    return execution;
  }
}
