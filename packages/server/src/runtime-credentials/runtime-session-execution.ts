import type {
  RuntimeCredentialClientFrame,
  RuntimeCredentialProvider,
  RuntimeExecutionOpenRejectCode,
  RuntimeExecutionOpenResult,
  RuntimeExecutionSource,
} from "@opentag/shared";
import type { ConnectionRegistry, RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import {
  type RuntimeCredentialBroker,
  RuntimeCredentialError,
  type RuntimeScopeMaterial,
} from "./credential-broker.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeGitHubAdmission } from "./github-admission.js";
import { VALIDATION_EXECUTION_MAX_LIFETIME_MS } from "./runtime-validation-execution.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "./scope-resolver.js";
import {
  type RuntimeExecutionProviderBinding,
  type RuntimeExecutionPurpose,
  type RuntimeExecutionRecord,
  runtimeExecutionProviderBinding,
  runtimeExecutionProviderKey,
} from "./types.js";

type ExecutionOpenFrame = Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>;
type CandidateProvider = "github" | "slack" | "feishu";

export interface RuntimeSessionExecutionDeps {
  registry: ConnectionRegistry;
  executions: RuntimeExecutionRegistry;
  authority: RuntimeExecutionAuthority;
  scopeResolver: RuntimeScopeResolverPort;
  broker: RuntimeCredentialBroker;
  gitHubAdmission: RuntimeGitHubAdmission;
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
}

/**
 * Opens one business (delivery / session-message) execution against the Session fence. Validation
 * sources never reach this path; they are handled by the isolated validation execution module.
 */
export async function openRuntimeSessionExecution(
  deps: RuntimeSessionExecutionDeps,
  frame: ExecutionOpenFrame,
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
  const checked = checkSessionOpen(frame, context, await deps.scopeResolver.load(frame.sessionId));
  if (!checked.ok) return rejected(checked.code);
  const snapshot = checked.snapshot;
  const sandboxMismatch = sessionSandboxMismatch(frame, snapshot);
  if (sandboxMismatch) return rejected(sandboxMismatch);
  if (snapshot.computer.kind === "cloud" && !(await cloudControlActive(deps, context.computerId))) {
    return rejected("execution_authority_denied");
  }
  const decision = await deps.authority.authorize(frame.source, {
    sessionId: frame.sessionId,
    agentId: frame.agentId,
    computerId: context.computerId,
    instanceId: context.instanceId,
    placementGeneration: frame.placementGeneration,
  });
  if (decision.status === "not_ready") return rejected("execution_not_ready");
  if (decision.status === "invalid") return rejected("execution_source_invalid");
  const purpose: RuntimeExecutionPurpose = decision.validation ? "validation" : "execution";
  const candidates = await candidateProviders(deps, snapshot, decision.validation, frame.source);
  if (candidates.length === 0) return rejected("execution_authority_denied");
  const record = openSessionRecord(deps, frame, context, snapshot, purpose, connectionId);
  if (!record) return rejected("owner_unavailable");
  const providers = await describeSessionCandidates(deps, record, candidates);
  if (providers.size === 0) {
    deps.executions.close(record.executionId, "execution_closed");
    return rejected("execution_authority_denied");
  }
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

function checkSessionOpen(
  frame: ExecutionOpenFrame,
  context: RuntimeBusinessContext,
  snapshot: RuntimeScopeSnapshot | undefined,
): { ok: true; snapshot: RuntimeScopeSnapshot } | { ok: false; code: RuntimeExecutionOpenRejectCode } {
  if (!snapshot) return { ok: false, code: "agent_mismatch" };
  if (snapshot.sessionKind === "internal") return { ok: false, code: "execution_authority_denied" };
  if (snapshot.sessionEnded) return { ok: false, code: "placement_stale" };
  if (snapshot.agent.id !== frame.agentId || snapshot.agent.computerId !== context.computerId) {
    return { ok: false, code: "agent_mismatch" };
  }
  if (snapshot.agent.status !== "active" || snapshot.computer.ownerAccountId !== snapshot.agent.createdByUserId) {
    return { ok: false, code: "agent_mismatch" };
  }
  if (
    !snapshot.placement ||
    snapshot.placement.computerId !== context.computerId ||
    snapshot.placement.generation !== frame.placementGeneration
  ) {
    return { ok: false, code: "placement_stale" };
  }
  return { ok: true, snapshot };
}

/** Cloud executions must match the exact Session Sandbox row; Local forbids one. */
function sessionSandboxMismatch(
  frame: ExecutionOpenFrame,
  snapshot: RuntimeScopeSnapshot,
): RuntimeExecutionOpenRejectCode | undefined {
  if (snapshot.computer.kind !== "cloud") return frame.sandbox ? "sandbox_mismatch" : undefined;
  const sandbox = snapshot.sandbox;
  if (!frame.sandbox || !sandbox) return "sandbox_mismatch";
  if (
    sandbox.id !== frame.sandbox.sandboxId ||
    sandbox.resourceUid !== frame.sandbox.resourceUid ||
    sandbox.environmentGeneration !== frame.sandbox.environmentGeneration ||
    sandbox.lifecycle !== "ready"
  ) {
    return "sandbox_mismatch";
  }
  return undefined;
}

async function cloudControlActive(deps: RuntimeSessionExecutionDeps, computerId: string): Promise<boolean> {
  const identity = deps.registry.currentControlIdentity(computerId);
  if (!identity) return false;
  return (await deps.cloudControlActive?.(identity)) === true;
}

function openSessionRecord(
  deps: RuntimeSessionExecutionDeps,
  frame: ExecutionOpenFrame,
  context: RuntimeBusinessContext,
  snapshot: RuntimeScopeSnapshot,
  purpose: RuntimeExecutionPurpose,
  connectionId: string,
): RuntimeExecutionRecord | undefined {
  try {
    return deps.executions.open({
      runId: frame.runId,
      accountId: snapshot.computer.ownerAccountId,
      agentId: snapshot.agent.id,
      agentRevision: snapshot.agent.revision,
      sessionId: snapshot.sessionId,
      computerId: context.computerId,
      instanceId: context.instanceId,
      connectionId,
      placementGeneration: frame.placementGeneration,
      source: frame.source,
      purpose,
      computerKind: snapshot.computer.kind,
      ...(frame.sandbox ? { sandbox: frame.sandbox } : {}),
      providers: new Map(),
      maxLifetimeMs: purpose === "validation" ? VALIDATION_EXECUTION_MAX_LIFETIME_MS : undefined,
    });
  } catch {
    return undefined;
  }
}

async function describeSessionCandidates(
  deps: RuntimeSessionExecutionDeps,
  record: RuntimeExecutionRecord,
  candidates: readonly { provider: CandidateProvider; bindingId: string }[],
): Promise<Map<string, RuntimeExecutionProviderBinding>> {
  const providers = new Map<string, RuntimeExecutionProviderBinding>();
  for (const candidate of candidates) {
    const described = await describeProvider(deps, record, candidate.provider, candidate.bindingId);
    if (!described) continue;
    providers.set(
      runtimeExecutionProviderKey(candidate.provider, candidate.bindingId),
      runtimeExecutionProviderBinding(candidate.provider, candidate.bindingId, described.cli),
    );
  }
  return providers;
}

/**
 * The Session's own IM binding plus, only with a fresh source-checked GitHub admission, the
 * GitHub connection. An admission denied for the exact accepted source simply drops the provider.
 */
async function candidateProviders(
  deps: RuntimeSessionExecutionDeps,
  snapshot: RuntimeScopeSnapshot,
  validation: { provider: CandidateProvider; bindingId: string } | undefined,
  source: RuntimeExecutionSource,
): Promise<{ provider: CandidateProvider; bindingId: string }[]> {
  if (validation) return [{ provider: validation.provider, bindingId: validation.bindingId }];
  const candidates: { provider: CandidateProvider; bindingId: string }[] = [
    { provider: snapshot.binding.provider, bindingId: snapshot.binding.id },
  ];
  const admission = await deps.gitHubAdmission
    .admit({
      accountId: snapshot.computer.ownerAccountId,
      agentId: snapshot.agent.id,
      sessionId: snapshot.sessionId,
      source,
    })
    .catch(() => undefined);
  if (admission) candidates.push({ provider: "github", bindingId: admission.connectionId });
  return candidates;
}

async function describeProvider(
  deps: RuntimeSessionExecutionDeps,
  record: RuntimeExecutionRecord,
  provider: RuntimeCredentialProvider,
  bindingId: string,
): Promise<RuntimeScopeMaterial | undefined> {
  try {
    return await deps.broker.describeProvider({ execution: record, provider, bindingId });
  } catch (error) {
    if (error instanceof RuntimeCredentialError) return undefined;
    throw error;
  }
}
