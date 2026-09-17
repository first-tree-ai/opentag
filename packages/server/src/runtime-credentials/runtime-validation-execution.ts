import type {
  RuntimeCredentialClientFrame,
  RuntimeCredentialProvider,
  RuntimeExecutionOpenRejectCode,
  RuntimeExecutionOpenResult,
} from "@opentag/shared";
import type { ConnectionRegistry, RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { type RuntimeCredentialBroker, RuntimeCredentialError } from "./credential-broker.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeScopeResolverPort, RuntimeValidationScopeSnapshot } from "./scope-resolver.js";
import {
  type RuntimeExecutionProviderBinding,
  type RuntimeExecutionRecord,
  runtimeExecutionProviderBinding,
  runtimeExecutionProviderKey,
} from "./types.js";
import type { RuntimeValidationRun, RuntimeValidationRunRegistry } from "./validation-runs.js";

/** Narrow injection port for the IM binding service to issue Server-side validation runs. */
export interface RuntimeValidationRunIssuer {
  issueValidationRun(input: {
    provider: "feishu" | "slack";
    bindingId: string;
    agentId: string;
    computerId: string;
    instanceId: string;
    connectionId?: string;
  }): Promise<{ validationRunId: string; expiresAt: number } | undefined>;
}

/** Provider CLI reconcile input shape mapped onto the validation run issuer. */
export interface ImBindingValidationRunRequest {
  agentId: string;
  computerId: string;
  instanceId: string;
  connectionId?: string;
  credentialGeneration: number;
  integrationId: string;
  provider: "feishu" | "slack";
}

/** Maps the provider-CLI reconcile input onto the Server validation run issuer. */
export function issueImBindingValidationRun(
  issuer: RuntimeValidationRunIssuer | undefined,
  input: ImBindingValidationRunRequest,
): Promise<{ validationRunId: string; expiresAt: number } | undefined> {
  return issuer
    ? issuer.issueValidationRun({
        provider: input.provider,
        bindingId: input.integrationId,
        agentId: input.agentId,
        computerId: input.computerId,
        instanceId: input.instanceId,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      })
    : Promise.resolve(undefined);
}

/** Validation executions are short-lived; the 24h bound applies to business executions. */
export const VALIDATION_EXECUTION_MAX_LIFETIME_MS = 10 * 60 * 1_000;

export interface RuntimeValidationExecutionDeps {
  registry: ConnectionRegistry;
  executions: RuntimeExecutionRegistry;
  validationRuns: RuntimeValidationRunRegistry;
  authority: RuntimeExecutionAuthority;
  scopeResolver: RuntimeScopeResolverPort;
  broker: RuntimeCredentialBroker;
  /** Live Cloud control credential check; Cloud validation fails closed when missing/denied. */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
}

/**
 * Server-issued validation executions: no business Session exists (and none may be invented).
 * Authority comes from the single-use validation run plus the fresh Agent/binding/Computer fence.
 * The run is consumed exactly once; every later failure still burns it, so the Client must request
 * a fresh run for a retry.
 */
export async function openRuntimeValidationExecution(
  deps: RuntimeValidationExecutionDeps,
  frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>,
  context: RuntimeBusinessContext,
): Promise<RuntimeExecutionOpenResult> {
  const rejected = (code: RuntimeExecutionOpenRejectCode): RuntimeExecutionOpenResult => ({
    type: "runtime:execution:result",
    requestId: frame.requestId,
    status: "rejected",
    code,
  });
  const connectionId = context.connectionId;
  if (!connectionId) return rejected("capability_unsupported");
  const decision = await deps.authority.authorize(frame.source, {
    sessionId: frame.sessionId,
    agentId: frame.agentId,
    computerId: context.computerId,
    instanceId: context.instanceId,
    placementGeneration: frame.placementGeneration,
  });
  if (decision.status === "not_ready") return rejected("execution_not_ready");
  if (decision.status === "invalid" || !decision.validation) return rejected("execution_source_invalid");
  const run = decision.validation;
  if (run.agentId !== frame.agentId || run.computerId !== context.computerId || run.instanceId !== context.instanceId) {
    return rejected("agent_mismatch");
  }
  const snapshot = await deps.scopeResolver.loadValidationScope?.({
    bindingId: run.bindingId,
    agentId: run.agentId,
  });
  if (!snapshot) return rejected("execution_authority_denied");
  const failure = validationFenceFailure(snapshot, {
    provider: run.provider,
    bindingId: run.bindingId,
    agentId: frame.agentId,
    computerId: context.computerId,
  });
  if (failure) return rejected(failure);
  if (snapshot.computer.kind === "cloud" && !(await cloudControlActive(deps, context.computerId))) {
    return rejected("execution_authority_denied");
  }
  const record = openValidationRecord(deps, frame, context, snapshot, run, connectionId);
  if (!record) return rejected("owner_unavailable");
  const described = await describeValidationProvider(deps, record, run.provider, run.bindingId);
  if (!described) {
    deps.executions.close(record.executionId, "execution_closed");
    return rejected("execution_authority_denied");
  }
  const providers = new Map<string, RuntimeExecutionProviderBinding>([
    [
      runtimeExecutionProviderKey(run.provider, run.bindingId),
      runtimeExecutionProviderBinding(run.provider, run.bindingId, described.cli),
    ],
  ]);
  const opened: RuntimeExecutionRecord = { ...record, providers };
  deps.executions.update(opened);
  return {
    type: "runtime:execution:result",
    requestId: frame.requestId,
    status: "succeeded",
    executionId: opened.executionId,
    expiresAt: new Date(opened.expiresAt).toISOString(),
    providers: [...providers.values()],
  };
}

function openValidationRecord(
  deps: RuntimeValidationExecutionDeps,
  frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>,
  context: RuntimeBusinessContext,
  snapshot: RuntimeValidationScopeSnapshot,
  run: RuntimeValidationRun,
  connectionId: string,
): RuntimeExecutionRecord | undefined {
  try {
    return deps.executions.open({
      runId: frame.runId,
      accountId: snapshot.computer.ownerAccountId,
      agentId: snapshot.agent.id,
      agentRevision: snapshot.agent.revision,
      sessionId: frame.sessionId,
      computerId: context.computerId,
      instanceId: context.instanceId,
      connectionId,
      placementGeneration: frame.placementGeneration,
      source: frame.source,
      purpose: "validation",
      computerKind: snapshot.computer.kind,
      validation: { provider: run.provider, bindingId: run.bindingId },
      providers: new Map(),
      maxLifetimeMs: VALIDATION_EXECUTION_MAX_LIFETIME_MS,
    });
  } catch {
    return undefined;
  }
}

/** Shared validation fence for both issuing a run and opening its execution. */
function validationFenceFailure(
  snapshot: RuntimeValidationScopeSnapshot,
  expected: { provider: RuntimeCredentialProvider; bindingId: string; agentId: string; computerId: string },
): "agent_mismatch" | "execution_authority_denied" | undefined {
  if (snapshot.agent.id !== expected.agentId || snapshot.agent.computerId !== expected.computerId) {
    return "agent_mismatch";
  }
  if (snapshot.computer.id !== expected.computerId) return "agent_mismatch";
  if (snapshot.agent.status !== "active" || snapshot.computer.ownerAccountId !== snapshot.agent.createdByUserId) {
    return "agent_mismatch";
  }
  if (
    snapshot.binding.id !== expected.bindingId ||
    snapshot.binding.provider !== expected.provider ||
    snapshot.binding.status !== "active"
  ) {
    return "execution_authority_denied";
  }
  if (
    expected.provider === "slack" &&
    (snapshot.slackInstallation?.status !== "active" || snapshot.slackInstallation.agentId !== snapshot.agent.id)
  ) {
    return "execution_authority_denied";
  }
  return undefined;
}

async function cloudControlActive(deps: RuntimeValidationExecutionDeps, computerId: string): Promise<boolean> {
  const identity = deps.registry.currentControlIdentity(computerId);
  if (!identity) return false;
  return (await deps.cloudControlActive?.(identity)) === true;
}

async function describeValidationProvider(
  deps: RuntimeValidationExecutionDeps,
  record: RuntimeExecutionRecord,
  provider: RuntimeCredentialProvider,
  bindingId: string,
) {
  try {
    return await deps.broker.describeProvider({ execution: record, provider, bindingId });
  } catch (error) {
    if (error instanceof RuntimeCredentialError) return undefined;
    throw error;
  }
}

/**
 * Issues the Server-side validation run that authorizes one isolated read-only validation
 * execution. Only an authoritative binding/agent/computer fence produces a run; unknown or
 * inactive facts return `undefined` and no run exists.
 */
export async function issueRuntimeValidationRun(
  deps: RuntimeValidationExecutionDeps,
  input: {
    provider: RuntimeCredentialProvider;
    bindingId: string;
    agentId: string;
    computerId: string;
    instanceId: string;
    connectionId?: string;
  },
): Promise<{ validationRunId: string; expiresAt: number } | undefined> {
  if (
    input.connectionId &&
    !deps.registry.isCurrentConnection(input.computerId, input.instanceId, input.connectionId)
  ) {
    return undefined;
  }
  const snapshot = await deps.scopeResolver.loadValidationScope?.({
    bindingId: input.bindingId,
    agentId: input.agentId,
  });
  if (!snapshot) return undefined;
  if (validationFenceFailure(snapshot, input)) return undefined;
  if (snapshot.computer.kind === "cloud" && !(await cloudControlActive(deps, input.computerId))) {
    return undefined;
  }
  try {
    const run = deps.validationRuns.issue({
      provider: input.provider,
      bindingId: input.bindingId,
      agentId: input.agentId,
      computerId: input.computerId,
      instanceId: input.instanceId,
    });
    return { validationRunId: run.validationRunId, expiresAt: run.expiresAt };
  } catch {
    return undefined;
  }
}
