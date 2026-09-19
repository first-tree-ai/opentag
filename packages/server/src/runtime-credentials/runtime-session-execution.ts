import type {
  RuntimeCredentialClientFrame,
  RuntimeCredentialProvider,
  RuntimeExecutionOpenRejectCode,
  RuntimeExecutionOpenResult,
  RuntimeExecutionService,
  RuntimeExecutionSource,
} from "@opentag/shared";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import {
  type RuntimeControlAuthority,
  type RuntimeCredentialBroker,
  RuntimeCredentialError,
  type RuntimeScopeMaterial,
} from "./credential-broker.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeGitHubAdmission } from "./github-admission.js";
import type { RuntimeMcpServicePolicy } from "./mcp-policy.js";
import { VALIDATION_EXECUTION_MAX_LIFETIME_MS } from "./runtime-validation-execution.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "./scope-resolver.js";
import {
  type RuntimeExecutionProviderBinding,
  type RuntimeExecutionPurpose,
  type RuntimeExecutionRecord,
  runtimeExecutionProviderBinding,
  runtimeExecutionProviderKey,
} from "./types.js";
import type { RuntimeWebServicePolicy } from "./web-policy.js";

type ExecutionOpenFrame = Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>;
type CandidateProvider = "github" | "slack" | "feishu";

export interface RuntimeSessionExecutionDeps {
  registry: RuntimeControlAuthority;
  executions: RuntimeExecutionRegistry;
  authority: RuntimeExecutionAuthority;
  scopeResolver: RuntimeScopeResolverPort;
  broker: RuntimeCredentialBroker;
  gitHubAdmission: RuntimeGitHubAdmission;
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
  /**
   * Deployment web service policy. Absent means no execution can carry web service scopes, which
   * keeps the feature fully off regardless of what a Client requests.
   */
  webPolicy?: RuntimeWebServicePolicy;
  /**
   * MCP gateway service policy. Absent means no execution can carry MCP scopes, which keeps the
   * gateway fully unreachable regardless of what a Client requests.
   */
  mcpPolicy?: RuntimeMcpServicePolicy;
  logger?: ServiceLogger;
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
  const services = await describeSessionServices(deps, frame, context, snapshot);
  if (candidates.length === 0 && services.length === 0) return rejected("execution_authority_denied");
  const record = openSessionRecord(deps, frame, context, snapshot, purpose, connectionId, services);
  if (!record) return rejected("owner_unavailable");
  const providers = await describeSessionCandidates(deps, record, candidates);
  if (providers.size === 0 && services.length === 0) {
    deps.executions.close(record.executionId, "execution_closed");
    return rejected("execution_authority_denied");
  }
  const opened: RuntimeExecutionRecord = { ...record, providers };
  deps.executions.update(opened);
  const wireServices = services.filter((service) => negotiated(context, service.service));
  return {
    type: "runtime:execution:result",
    requestId: frame.requestId,
    status: "succeeded",
    executionId: opened.executionId,
    expiresAt: new Date(opened.expiresAt).toISOString(),
    providers: [...providers.values()],
    /*
     * Each grant is on the wire only when the Client negotiated that service's own capability, so an
     * older Client never sees a field its strict schema would reject. The filter is per service
     * rather than per frame: gating the whole array on one capability would have shipped an MCP
     * grant to a peer that negotiated only webTools.
     */
    ...(wireServices.length > 0 ? { services: wireServices } : {}),
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
  const identity = deps.registry.currentControlIdentity?.(computerId);
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
  services: readonly RuntimeExecutionService[],
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
      ...(services.length > 0 ? { services } : {}),
      maxLifetimeMs: purpose === "validation" ? VALIDATION_EXECUTION_MAX_LIFETIME_MS : undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * The capability each platform service rides on.
 *
 * Kept as a table rather than a chain of `if`s because the emit gate and this function must agree
 * exactly: a service whose capability the peer did not negotiate must be neither granted here nor
 * put on the wire below, and a single shared table is what makes those two statements one fact.
 */
const SERVICE_CAPABILITY: Record<RuntimeExecutionService["service"], string> = {
  web: RUNTIME_CAPABILITY.webTools,
  mcp: RUNTIME_CAPABILITY.mcpGateway,
};

function negotiated(context: RuntimeBusinessContext, service: RuntimeExecutionService["service"]): boolean {
  return context.negotiatedCapabilities?.[SERVICE_CAPABILITY[service]] === 1;
}

/**
 * Platform services attach only when the Client explicitly requested them over that service's own
 * negotiated capability, the policy authorizes the subject, and the Session fence already passed. A
 * requested-but-unauthorized service is omitted (its tools never register), never silently granted
 * through a shared default.
 */
async function describeSessionServices(
  deps: RuntimeSessionExecutionDeps,
  frame: ExecutionOpenFrame,
  context: RuntimeBusinessContext,
  snapshot: RuntimeScopeSnapshot,
): Promise<RuntimeExecutionService[]> {
  const services: RuntimeExecutionService[] = [];
  if (negotiated(context, "web") && frame.services?.includes("web") && deps.webPolicy) {
    const scopes = deps.webPolicy.authorizeWeb({ accountId: snapshot.computer.ownerAccountId });
    if (scopes && scopes.length > 0) services.push({ service: "web", scopes: [...scopes] });
  }
  const mcp = await describeMcpService(deps, frame, context, snapshot);
  if (mcp) services.push(mcp);
  return services;
}

/**
 * The MCP gateway grant, and a record of why it was withheld when it was.
 *
 * Withholding is silent everywhere else, which is the problem: a user binds an MCP Server on the
 * web, watches its probe succeed, and then the Agent has no tools and nothing anywhere says why.
 * The commonest cause is not a mistake in the MCP configuration at all — the credential relay only
 * runs in proxy mode, so a Client on the default `legacy` mode never asks for the service and this
 * function is never even reached with a request.
 *
 * Logged at debug because it is per execution open and most deployments bind no MCP Server at all;
 * the reason code is what makes the silence explicable when someone does go looking.
 */
async function describeMcpService(
  deps: RuntimeSessionExecutionDeps,
  frame: ExecutionOpenFrame,
  context: RuntimeBusinessContext,
  snapshot: RuntimeScopeSnapshot,
): Promise<RuntimeExecutionService | undefined> {
  const withheld = (reason: string): undefined => {
    deps.logger?.debug(
      { code: "MCP_GATEWAY_NOT_GRANTED", reason, agentId: snapshot.agent.id },
      "The execution did not receive the MCP gateway service",
    );
    return undefined;
  };
  if (!negotiated(context, "mcp")) return withheld("capability_not_negotiated");
  // A Client in legacy credential mode opens no execution through the relay at all; one that does
  // open an execution without naming the service has the capability but did not opt in.
  if (!frame.services?.includes("mcp")) return withheld("not_requested");
  if (!deps.mcpPolicy) return withheld("policy_unavailable");
  const scopes = await deps.mcpPolicy.authorizeMcp({
    accountId: snapshot.computer.ownerAccountId,
    agentId: snapshot.agent.id,
  });
  // The ordinary case: this Agent has no enabled mount with an active authorization.
  if (!scopes || scopes.length === 0) return withheld("no_usable_mount");
  return { service: "mcp", scopes: [...scopes] };
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
