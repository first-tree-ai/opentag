import type { RuntimeCredentialProvider, RuntimeCredentialRejectCode, RuntimeImOutboxContext } from "@opentag/shared";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeCapabilityRecord, RuntimeCapabilityStore } from "./capability-store.js";
import type { RuntimeExecutionAuthority } from "./execution-authority.js";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import type { RuntimeGitHubAdmission, RuntimeGitHubAdmissionResult } from "./github-admission.js";
import type { RuntimeProviderMaterial, RuntimeProviderMaterialResolver } from "./provider-material.js";
import { imAuthorizationRevision, imCredentialGenerationPin } from "./provider-material.js";
import { computeGitHubScopeHash, computeImScopeHash } from "./scope-hash.js";
import {
  assertValidationExecutionFence,
  type RuntimeBindingSnapshot,
  type RuntimeFenceViolation,
  type RuntimeScopeResolverPort,
  type RuntimeScopeSnapshot,
  type RuntimeSlackInstallationSnapshot,
  type RuntimeValidationScopeSnapshot,
} from "./scope-resolver.js";
import type { RuntimeTaskPolicy } from "./task-policy.js";
import type { RuntimeCliMetadata, RuntimeExecutionPurpose, RuntimeExecutionRecord } from "./types.js";
import { runtimeExecutionProviderKey } from "./types.js";

export class RuntimeCredentialError extends Error {
  constructor(
    readonly code: RuntimeCredentialRejectCode,
    message?: string,
  ) {
    super(message ?? `Runtime credential rejected: ${code}`);
    this.name = "RuntimeCredentialError";
  }
}

/** Server-only authorization snapshot handed to provider adapters; never serialized anywhere. */
export interface RuntimeProxyAuthorization {
  executionId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  purpose: RuntimeExecutionPurpose;
  scopeHash: string;
  authorizationRevision: string;
  credentialGeneration: string;
  sessionId: string;
  accountId: string;
  agentId: string;
  cli: RuntimeCliMetadata;
  /** Resolves real upstream material in memory; callers must `recheck()` after this async step. */
  resolveMaterial(signal?: AbortSignal): Promise<RuntimeProviderMaterial>;
  /** Fresh DB fence revalidation, required after any async material/cipher boundary. */
  recheck(signal?: AbortSignal): Promise<void>;
}

export interface RuntimeScopeMaterial {
  scopeHash: string;
  authorizationRevision: string;
  credentialGeneration: string;
  cli: RuntimeCliMetadata;
}

export type RuntimeGrantOutcome =
  | { status: "succeeded"; token: string; record: RuntimeCapabilityRecord; cli: RuntimeCliMetadata }
  | { status: "rejected"; code: RuntimeCredentialRejectCode };

/** Exact control-connection fence: an execution dies with the connection that opened it. */
export interface RuntimeConnectionFence {
  isCurrent(computerId: string, instanceId: string, connectionId: string): boolean;
  /** Current active Cloud control identity; undefined for Local/absent connections. */
  currentControlIdentity?(computerId: string): RuntimeControlIdentity | undefined;
}

export interface RuntimeCredentialBrokerOptions {
  capabilities: RuntimeCapabilityStore;
  executions: RuntimeExecutionRegistry;
  scopeResolver: RuntimeScopeResolverPort;
  policy: RuntimeTaskPolicy;
  gitHubAdmission: RuntimeGitHubAdmission;
  materialResolvers: Partial<Record<RuntimeCredentialProvider, RuntimeProviderMaterialResolver>>;
  /** Accepted-custody / collaboration revalidation; absent means scope fences only (tests). */
  authority?: RuntimeExecutionAuthority;
  /** Exact current control connection; absent means the registry fence is enforced elsewhere. */
  connectionFence?: RuntimeConnectionFence;
  /**
   * Live Cloud control credential check (`authority.isActive`) for every Cloud request. Absent
   * means Cloud fails closed: auth-time acceptance alone never admits or keeps Cloud data access.
   */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
}

function fenceViolationCode(violation: RuntimeFenceViolation): RuntimeCredentialRejectCode {
  switch (violation) {
    case "session_unknown":
      return "execution_unknown";
    case "session_ended":
    case "session_internal":
      return "execution_closed";
    case "binding_inactive":
    case "installation_inactive":
      return "binding_inactive";
    case "ownership_mismatch":
      return "credential_scope_denied";
    default:
      return "credential_stale";
  }
}

type RuntimeFenceSnapshot =
  | { kind: "session"; snapshot: RuntimeScopeSnapshot }
  | { kind: "validation"; snapshot: RuntimeValidationScopeSnapshot };

interface RuntimeImMaterialFacts {
  binding: RuntimeBindingSnapshot;
  slackInstallation: RuntimeSlackInstallationSnapshot | null;
  agentId: string;
  outbox?: { sessionKind: "channel" | "thread" | "internal"; channelId: string; threadKey: string | null };
}

/**
 * Issues, renews, and revalidates short-lived capabilities. Every acquire, renew, and data request
 * re-reads the authoritative DB fence; nothing is authorized from a cached snapshot, and a copied
 * capability fails the same per-request checks from any other execution or connection.
 */
export class RuntimeCredentialBroker {
  readonly #options: RuntimeCredentialBrokerOptions;

  constructor(options: RuntimeCredentialBrokerOptions) {
    this.#options = options;
  }

  async acquire(input: {
    execution: RuntimeExecutionRecord;
    provider: RuntimeCredentialProvider;
    bindingId: string;
    signal?: AbortSignal;
  }): Promise<RuntimeGrantOutcome> {
    const binding = input.execution.providers.get(runtimeExecutionProviderKey(input.provider, input.bindingId));
    if (!binding) return { status: "rejected", code: "provider_mismatch" };
    try {
      const material = await this.#scopeMaterial(input.execution, input.provider, input.bindingId, input.signal);
      const { record, token } = this.#options.capabilities.issue({
        executionId: input.execution.executionId,
        provider: input.provider,
        bindingId: input.bindingId,
        purpose: input.execution.purpose,
        scopeHash: material.scopeHash,
        authorizationRevision: material.authorizationRevision,
        credentialGeneration: material.credentialGeneration,
      });
      return { status: "succeeded", token, record, cli: material.cli };
    } catch (error) {
      if (error instanceof RuntimeCredentialError) return { status: "rejected", code: error.code };
      throw error;
    }
  }

  async renew(input: {
    execution: RuntimeExecutionRecord;
    grantId: string;
    signal?: AbortSignal;
  }): Promise<RuntimeGrantOutcome> {
    const grant = this.#options.capabilities.lookupGrant(input.execution.executionId, input.grantId);
    if (!grant) return { status: "rejected", code: "grant_mismatch" };
    return this.acquire({
      execution: input.execution,
      provider: grant.provider,
      bindingId: grant.bindingId,
      signal: input.signal,
    });
  }

  /**
   * Authorizes one data-plane request: capability hash must be live, provider/binding must match,
   * the execution must be open on a current control connection, and the fresh DB fence plus scope
   * must still equal the values pinned at issuance.
   */
  async beginRequest(input: {
    capability: string;
    provider: RuntimeCredentialProvider;
    bindingId: string;
    signal?: AbortSignal;
  }): Promise<RuntimeProxyAuthorization> {
    const grant = this.#options.capabilities.lookup(input.capability);
    if (!grant) throw new RuntimeCredentialError("credential_stale");
    if (grant.provider !== input.provider || grant.bindingId !== input.bindingId) {
      throw new RuntimeCredentialError("provider_mismatch");
    }
    const execution = this.#options.executions.get(grant.executionId);
    if (!execution) throw new RuntimeCredentialError("execution_closed");
    const material = await this.#scopeMaterial(execution, grant.provider, grant.bindingId, input.signal);
    if (material.scopeHash !== grant.scopeHash) throw new RuntimeCredentialError("credential_stale");
    const authorization: RuntimeProxyAuthorization = {
      executionId: execution.executionId,
      provider: grant.provider,
      bindingId: grant.bindingId,
      purpose: grant.purpose,
      scopeHash: grant.scopeHash,
      authorizationRevision: grant.authorizationRevision,
      credentialGeneration: grant.credentialGeneration,
      sessionId: execution.sessionId,
      accountId: execution.accountId,
      agentId: execution.agentId,
      cli: material.cli,
      resolveMaterial: async (signal) => {
        const resolver = this.#options.materialResolvers[grant.provider];
        if (!resolver) throw new RuntimeCredentialError("credential_stale");
        const resolved = await resolver.resolve({
          executionId: execution.executionId,
          provider: grant.provider,
          bindingId: grant.bindingId,
          accountId: execution.accountId,
          agentId: execution.agentId,
          credentialGeneration: grant.credentialGeneration,
          signal,
        });
        if (!resolved) throw new RuntimeCredentialError("credential_stale");
        return resolved;
      },
      recheck: async (signal) => this.revalidate(authorization, signal),
    };
    return authorization;
  }

  /** Long-stream revalidation: the fence and scope must still hold; token rotation is tolerated. */
  async revalidate(authorization: RuntimeProxyAuthorization, signal?: AbortSignal): Promise<void> {
    const execution = this.#options.executions.get(authorization.executionId);
    if (!execution) throw new RuntimeCredentialError("execution_closed");
    const material = await this.#scopeMaterial(execution, authorization.provider, authorization.bindingId, signal);
    if (material.scopeHash !== authorization.scopeHash) throw new RuntimeCredentialError("credential_stale");
    if (material.authorizationRevision !== authorization.authorizationRevision) {
      throw new RuntimeCredentialError("credential_stale");
    }
    // A long-lived stream outlives its original capability. It stays authorized only while at
    // least one live capability still matches this exact execution/provider/binding/scope and
    // revision; renewal overlap is fine because current and previous grants both count, while
    // revocation or a stopped renewal ends the stream within the revalidation bound.
    if (
      !this.#options.capabilities.hasLiveMatching({
        executionId: authorization.executionId,
        provider: authorization.provider,
        bindingId: authorization.bindingId,
        scopeHash: authorization.scopeHash,
        authorizationRevision: authorization.authorizationRevision,
      })
    ) {
      throw new RuntimeCredentialError("credential_stale");
    }
  }

  revokeExecution(executionId: string): void {
    this.#options.capabilities.revokeExecution(executionId);
  }

  /** Describes the scope material for one provider binding without issuing a capability. */
  describeProvider(input: {
    execution: RuntimeExecutionRecord;
    provider: RuntimeCredentialProvider;
    bindingId: string;
    signal?: AbortSignal;
  }): Promise<RuntimeScopeMaterial> {
    return this.#scopeMaterial(input.execution, input.provider, input.bindingId, input.signal);
  }

  async #fence(execution: RuntimeExecutionRecord, signal?: AbortSignal): Promise<RuntimeFenceSnapshot> {
    signal?.throwIfAborted();
    this.#assertCurrentConnection(execution);
    await this.#assertCloudControl(execution);
    await this.#assertAdmission(execution);
    return execution.purpose === "validation" ? this.#validationFence(execution) : this.#sessionFence(execution);
  }

  #assertCurrentConnection(execution: RuntimeExecutionRecord): void {
    const fence = this.#options.connectionFence;
    if (fence && !fence.isCurrent(execution.computerId, execution.instanceId, execution.connectionId)) {
      throw new RuntimeCredentialError("execution_closed");
    }
  }

  /** Cloud keeps access only while the current connection presents a live control credential. */
  async #assertCloudControl(execution: RuntimeExecutionRecord): Promise<void> {
    if (execution.computerKind !== "cloud") return;
    const identity = this.#options.connectionFence?.currentControlIdentity?.(execution.computerId);
    if (identity?.kind !== "cloud" || identity.computerId !== execution.computerId) {
      throw new RuntimeCredentialError("execution_closed");
    }
    if ((await this.#options.cloudControlActive?.(identity)) !== true) {
      throw new RuntimeCredentialError("execution_closed");
    }
  }

  async #assertAdmission(execution: RuntimeExecutionRecord): Promise<void> {
    const revalidation = await this.#options.authority?.revalidate(execution.source, {
      sessionId: execution.sessionId,
      agentId: execution.agentId,
      computerId: execution.computerId,
      instanceId: execution.instanceId,
    });
    if (revalidation === "invalid") throw new RuntimeCredentialError("execution_closed");
    if (revalidation === "not_ready") throw new RuntimeCredentialError("execution_unknown");
  }

  async #validationFence(execution: RuntimeExecutionRecord): Promise<RuntimeFenceSnapshot> {
    const target = execution.validation;
    const loadValidationScope = this.#options.scopeResolver.loadValidationScope;
    if (!target || !loadValidationScope) throw new RuntimeCredentialError("execution_closed");
    const snapshot = await loadValidationScope.call(this.#options.scopeResolver, {
      bindingId: target.bindingId,
      agentId: execution.agentId,
    });
    if (!snapshot) throw new RuntimeCredentialError("execution_unknown");
    const violation = assertValidationExecutionFence(execution, snapshot);
    if (violation) throw new RuntimeCredentialError(fenceViolationCode(violation));
    return { kind: "validation", snapshot };
  }

  async #sessionFence(execution: RuntimeExecutionRecord): Promise<RuntimeFenceSnapshot> {
    const snapshot = await this.#options.scopeResolver.load(execution.sessionId);
    if (!snapshot) throw new RuntimeCredentialError("execution_unknown");
    const violation = this.#options.scopeResolver.assertExecutionFence(execution, snapshot);
    if (violation) throw new RuntimeCredentialError(fenceViolationCode(violation));
    return { kind: "session", snapshot };
  }

  async #scopeMaterial(
    execution: RuntimeExecutionRecord,
    provider: RuntimeCredentialProvider,
    bindingId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeScopeMaterial> {
    const fence = await this.#fence(execution, signal);
    const permitted = await this.#options.policy.authorize({
      accountId: execution.accountId,
      agentId: execution.agentId,
      sessionId: execution.sessionId,
      provider,
      bindingId,
      sessionBindingId: fence.snapshot.binding.id,
      source: execution.source,
      purpose: execution.purpose,
    });
    if (permitted !== "permit") throw new RuntimeCredentialError("credential_scope_denied");
    if (provider === "github") return this.#gitHubScopeMaterial(execution, bindingId, signal);
    return this.#imScopeMaterial(execution, provider, bindingId, imMaterialFacts(fence));
  }

  #imScopeMaterial(
    execution: RuntimeExecutionRecord,
    provider: RuntimeCredentialProvider,
    bindingId: string,
    facts: RuntimeImMaterialFacts,
  ): RuntimeScopeMaterial {
    if (bindingId !== facts.binding.id || facts.binding.provider !== provider) {
      throw new RuntimeCredentialError("provider_mismatch");
    }
    if (provider === "feishu") {
      const generation = imCredentialGenerationPin("feishu", facts.binding.credentialGeneration);
      const outbox = imOutboxContext(facts, "feishu");
      return {
        scopeHash: computeImScopeHash(execution, provider, bindingId, generation),
        authorizationRevision: imAuthorizationRevision("feishu", facts.binding.credentialGeneration),
        credentialGeneration: generation,
        cli: {
          provider: "feishu",
          appId: facts.binding.externalAppId ?? "",
          teamBrand: facts.binding.externalTeamBrand === "lark" ? "lark" : "feishu",
          ...(outbox ? { outboxContext: outbox } : {}),
        },
      };
    }
    const installation = facts.slackInstallation;
    if (installation?.status !== "active" || installation.agentId !== facts.agentId) {
      throw new RuntimeCredentialError("binding_inactive");
    }
    const generation = imCredentialGenerationPin(
      "slack",
      facts.binding.credentialGeneration,
      installation.credentialGeneration,
    );
    const outbox = imOutboxContext(facts, "slack");
    return {
      scopeHash: computeImScopeHash(execution, provider, bindingId, generation),
      authorizationRevision: imAuthorizationRevision(
        "slack",
        facts.binding.credentialGeneration,
        installation.credentialGeneration,
      ),
      credentialGeneration: generation,
      cli: {
        provider: "slack",
        teamId: installation.externalTeamId ?? facts.binding.externalTeamId ?? "",
        botUserId: installation.externalBotId ?? "",
        ...(outbox ? { outboxContext: outbox } : {}),
      },
    };
  }

  async #gitHubScopeMaterial(
    execution: RuntimeExecutionRecord,
    bindingId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeScopeMaterial> {
    const admission = await this.#options.gitHubAdmission.admit({
      accountId: execution.accountId,
      agentId: execution.agentId,
      sessionId: execution.sessionId,
      source: execution.source,
      signal,
    });
    if (!admission || admission.connectionId !== bindingId) {
      throw new RuntimeCredentialError("credential_scope_denied");
    }
    return {
      // Normal UAT refresh rotates `credentialGeneration` only; the scope hash intentionally
      // excludes it so unchanged repository scopes do not revoke in-flight capabilities. An
      // `authorizationVersion` change or any binding/role/access change does invalidate.
      scopeHash: computeGitHubScopeHash(execution, bindingId, admission),
      authorizationRevision: `github:${admission.authorizationVersion}`,
      credentialGeneration: admission.credentialGeneration,
      cli: gitHubCliMetadata(admission, execution),
    };
  }
}

function imMaterialFacts(fence: RuntimeFenceSnapshot): RuntimeImMaterialFacts {
  if (fence.kind === "validation") {
    return {
      binding: fence.snapshot.binding,
      slackInstallation: fence.snapshot.slackInstallation,
      agentId: fence.snapshot.agent.id,
    };
  }
  return {
    binding: fence.snapshot.binding,
    slackInstallation: fence.snapshot.slackInstallation,
    agentId: fence.snapshot.agent.id,
    outbox: {
      sessionKind: fence.snapshot.sessionKind,
      channelId: fence.snapshot.channelId,
      threadKey: fence.snapshot.threadKey,
    },
  };
}

function imOutboxContext(
  facts: RuntimeImMaterialFacts,
  provider: "feishu" | "slack",
): RuntimeImOutboxContext | undefined {
  const outbox = facts.outbox;
  if (!outbox || outbox.sessionKind === "internal") return undefined;
  // The wire schema requires a thread reference exactly for thread Sessions.
  if (outbox.sessionKind === "thread" && !outbox.threadKey) return undefined;
  const thread = outbox.threadKey ?? undefined;
  if (provider === "feishu") {
    return {
      provider: "feishu",
      sessionKind: outbox.sessionKind,
      chatId: outbox.channelId,
      ...(thread ? { threadId: thread } : {}),
    };
  }
  return {
    provider: "slack",
    sessionKind: outbox.sessionKind,
    channelId: outbox.channelId,
    ...(thread ? { threadTs: thread } : {}),
  };
}

function gitHubCliMetadata(
  admission: RuntimeGitHubAdmissionResult,
  execution: RuntimeExecutionRecord,
): RuntimeCliMetadata {
  return {
    provider: "github",
    connectionId: admission.connectionId,
    repositories: admission.bindings.slice(0, 100).map((binding) => ({
      repositoryId: binding.repositoryId,
      fullName: binding.fullName,
      role: binding.role,
      access: binding.access,
      ...(binding.scope?.branch ? { branch: binding.scope.branch } : {}),
      ...(binding.scope?.publish ? { publish: binding.scope.publish } : {}),
      ...(binding.access === "write"
        ? { workBranchPrefix: `refs/heads/opentag/${execution.sessionId}/${binding.role}/` }
        : {}),
    })),
  };
}
