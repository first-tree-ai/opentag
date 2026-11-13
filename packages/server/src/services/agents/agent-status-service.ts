import {
  AgentStatusIdsSchema,
  type AgentStatusReason,
  type AgentStatusResponse,
  AgentStatusResponseSchema,
  type AgentStatusSnapshot,
  AgentStatusSnapshotSchema,
  type CloudAvailability,
  RUNTIME_SELF_CHECK_INITIAL_TIMEOUT_MS,
} from "@opentag/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, slackInstallations } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import type { ApplicationCipher } from "../crypto.js";
import { inspectBindingCredentials } from "../im-bindings/credential-material.js";
import { AgentServiceError, resourceNotFound } from "./errors.js";

type BindingScope = {
  binding: typeof imBindings.$inferSelect;
  installation: typeof slackInstallations.$inferSelect | null;
};

export class AgentStatusService {
  constructor(
    readonly database: DatabaseClient,
    readonly registry: ConnectionRegistry,
    readonly cipher: ApplicationCipher,
    readonly options: {
      now?: () => Date;
      cloudAvailability?: (now: Date) => CloudAvailability;
      refreshLegacy?: (computerId: string) => void;
      logger?: Pick<ServiceLogger, "warn">;
    } = {},
  ) {}

  async read(accountId: string, input: readonly string[]): Promise<AgentStatusResponse> {
    const ids = AgentStatusIdsSchema.parse([...input]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await this.database.transaction(
        async (tx) => {
          const owned = await tx
            .select()
            .from(agents)
            .where(and(inArray(agents.id, ids), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")));
          if (owned.length !== ids.length) throw resourceNotFound();
          const computerIds = [...new Set(owned.flatMap((agent) => (agent.computerId ? [agent.computerId] : [])))];
          const machines = computerIds.length
            ? await tx
                .select()
                .from(computers)
                .where(
                  and(
                    inArray(computers.id, computerIds),
                    eq(computers.ownerAccountId, accountId),
                    isNull(computers.deletedAt),
                  ),
                )
            : [];
          const bindings = await tx
            .select({ binding: imBindings, installation: slackInstallations })
            .from(imBindings)
            .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
            .where(and(inArray(imBindings.agentId, ids), ne(imBindings.status, "disabled")));
          return { owned, machines, bindings };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      const replaced = snapshot.machines.some((computer) => {
        if (
          computer.kind === "cloud" ||
          !computer.currentInstanceId ||
          this.registry.connectionStatus(computer.id) === "offline"
        )
          return false;
        return (
          this.registry.currentInstanceId(computer.id) !== computer.currentInstanceId ||
          this.registry.currentConnectionId(computer.id, computer.currentInstanceId) !==
            (computer.currentConnectionId ?? undefined) ||
          this.registry.installationId(computer.id) !== computer.currentInstallationId
        );
      });
      if (replaced) continue;
      const machines = new Map(snapshot.machines.map((computer) => [computer.id, computer]));
      const bindings = new Map(snapshot.bindings.map((scope) => [scope.binding.agentId, scope]));
      const owned = new Map(snapshot.owned.map((agent) => [agent.id, agent]));
      const now = this.options.now?.() ?? new Date();
      const statuses = ids.map((id) => {
        const agent = owned.get(id);
        if (!agent) throw resourceNotFound();
        return this.#project(
          agent,
          agent.computerId ? machines.get(agent.computerId) : undefined,
          bindings.get(id),
          now,
        );
      });
      const legacy = new Set(
        snapshot.machines
          .filter((computer) => computer.kind === "local" && !this.registry.selfCheckState(computer.id))
          .map((computer) => computer.id),
      );
      for (const computerId of legacy) this.options.refreshLegacy?.(computerId);
      return AgentStatusResponseSchema.parse({ statuses });
    }
    throw new AgentServiceError(
      "AGENT_REVISION_CONFLICT",
      "deterministic",
      "The runtime connection changed during the status read",
      409,
    );
  }

  #project(
    agent: typeof agents.$inferSelect,
    computer: typeof computers.$inferSelect | undefined,
    scope: BindingScope | undefined,
    now: Date,
  ): AgentStatusSnapshot {
    const binding = scope?.binding;
    const cloud = computer?.kind === "cloud" ? this.options.cloudAvailability?.(now) : undefined;
    const online = computerOnline(computer, this.registry);
    const selfCheck = computer ? this.registry.selfCheckState(computer.id) : undefined;
    const provider = computer
      ? this.registry
          .providerReadiness(computer.id, now.getTime())
          .find((value) => value.observation.provider === agent.runtimeProvider)
      : undefined;
    const runtimeStatus =
      computer?.kind === "cloud"
        ? cloud?.available
          ? "ready"
          : "unavailable"
        : (provider?.observation.status ?? null);
    const result: AgentStatusSnapshot = {
      agentId: agent.id,
      agentRevision: agent.revision,
      agentUpdatedAt: agent.updatedAt.toISOString(),
      agentStatus: agent.status as "active" | "suspended",
      observedAt: now.toISOString(),
      checkedAt: selfCheck?.checkedAt ?? (provider ? new Date(provider.observedAt).toISOString() : null),
      state: "problem",
      reason: "runtime_unavailable",
      runtimeProvider: agent.runtimeProvider,
      runtimeStatus,
      computer: computer
        ? {
            computerId: computer.id,
            kind: computer.kind,
            displayName: computer.displayName,
            platform: computer.platform,
            online,
            lastSeenAt: computer.lastSeenAt?.toISOString() ?? null,
          }
        : null,
      messaging: binding
        ? {
            id: binding.id,
            agentId: agent.id,
            provider: binding.provider,
            bindingState: binding.status,
            bot: { displayName: binding.botDisplayName, avatarUrl: binding.botAvatarUrl },
            receiveMode: agent.receiveMode,
            lastInboundAt: null,
            lastValidatedAt: binding.activatedAt?.toISOString() ?? null,
            lastRuntimeObservationAt: binding.observedAt?.toISOString() ?? null,
          }
        : null,
      ...(cloud ? { cloud } : {}),
    };
    return AgentStatusSnapshotSchema.parse({
      ...result,
      ...this.#verdict(agent, computer, scope, online, runtimeStatus, selfCheck, now),
    });
  }

  #verdict(
    agent: typeof agents.$inferSelect,
    computer: typeof computers.$inferSelect | undefined,
    scope: BindingScope | undefined,
    online: boolean,
    runtimeStatus: AgentStatusSnapshot["runtimeStatus"],
    selfCheck: SelfCheck,
    now: Date,
  ): Verdict {
    const binding = scope?.binding;
    if (!agent.computerId) return problem("computer_not_bound");
    if (!computer) return problem("computer_access_required");
    if (!online) return { state: "computer_offline", reason: "computer_offline" };
    if (agent.status === "suspended") return problem("agent_paused");
    const initial = Boolean(
      selfCheck &&
        selfCheck.startedAt !== undefined &&
        now.getTime() - selfCheck.startedAt < RUNTIME_SELF_CHECK_INITIAL_TIMEOUT_MS,
    );
    const runtime = runtimeVerdict(runtimeStatus, selfCheck, initial);
    if (runtime) return runtime;
    if (!binding || !scope) return problem("im_not_connected");
    const messaging = this.#messagingProblem(scope, agent.id, now);
    if (messaging) return problem(messaging);
    if (computer.kind === "cloud") return { state: "ready", reason: null };
    const verdict = this.#localMessagingVerdict(agent.id, computer.id, binding, selfCheck, initial, now);
    return verdict;
  }

  #messagingProblem(scope: BindingScope, agentId: string, now: Date): AgentStatusReason | undefined {
    const { binding, installation } = scope;
    if (binding.status === "provisioning") return "im_provisioning";
    const inspection = inspectBindingCredentials(this.cipher, binding, installation, {
      agentId,
      bindingId: binding.id,
      slackInstallationId: binding.slackInstallationId ?? undefined,
      logger: this.options.logger,
    });
    if (
      binding.status === "reauthorization_required" ||
      installation?.status === "reauthorization_required" ||
      inspection.missingCapabilities.length
    )
      return "im_reauthorization_required";
    if (binding.status !== "active" || !installationMatches(binding, installation, agentId)) return "im_error";
    if (inspection.status !== "valid") return "credential_validation_failed";
    if (!messagingConnected(scope, now)) return "im_error";
    return undefined;
  }

  #localMessagingVerdict(
    agentId: string,
    computerId: string,
    binding: BindingScope["binding"],
    selfCheck: SelfCheck,
    initial: boolean,
    now: Date,
  ): Verdict {
    const matches = (observation: { agentId: string; integrationId: string; credentialGeneration: number }) =>
      observation.agentId === agentId &&
      observation.integrationId === binding.id &&
      observation.credentialGeneration === binding.credentialGeneration;
    const artifact = this.registry
      .providerCliArtifactReadiness(computerId, now.getTime())
      .find((value) => matches(value.observation))?.observation;
    if (selfCheck?.problems.some((problem) => problem.part === "messaging_cli" && problem.reason === "check_timed_out"))
      return problem("messaging_cli_check_timed_out");
    if (artifact?.status !== "ready") {
      const preparing = !artifact || artifact.status === "checking";
      if (initial || (!selfCheck && preparing)) return initializing(selfCheck);
      // A CLI still being prepared (for example after the daemon restarts) has not failed: it is a
      // check that has not answered yet, which resolves on its own, so it never reads as unavailable.
      return problem(preparing ? "messaging_cli_check_timed_out" : "messaging_cli_unavailable");
    }
    const credential = this.registry
      .providerCliCredentialReadiness(computerId, now.getTime())
      .find((value) => matches(value.observation))?.observation;
    if (credential?.status === "ready") return { state: "ready", reason: null };
    if (credential?.status === "needs_attention") return problem(credentialProblem(credential));
    const firstCheckAt = credential?.observedAt ?? binding.activatedAt?.getTime();
    const firstCheckPending =
      firstCheckAt !== undefined && now.getTime() - firstCheckAt < RUNTIME_SELF_CHECK_INITIAL_TIMEOUT_MS;
    if (firstCheckPending || initial || !selfCheck) return initializing(selfCheck);
    return problem("credential_validation_timeout");
  }
}

type Verdict = Pick<AgentStatusSnapshot, "state" | "reason">;
type SelfCheck = ReturnType<ConnectionRegistry["selfCheckState"]>;
function problem(reason: AgentStatusReason): Verdict {
  return { state: "problem", reason };
}
function initializing(selfCheck: SelfCheck): Verdict {
  return { state: "initializing", reason: selfCheck ? "first_validation" : "legacy_checking" };
}
function runtimeVerdict(
  status: AgentStatusSnapshot["runtimeStatus"],
  selfCheck: SelfCheck,
  initial: boolean,
): Verdict | undefined {
  if (selfCheck?.stale) return problem("self_check_report_stale");
  if (selfCheck?.problems.some((value) => value.part === "runtime" && value.reason === "check_timed_out"))
    return problem("runtime_check_timed_out");
  if (status === null || status === "checking")
    return !selfCheck || initial ? initializing(selfCheck) : problem("runtime_check_timed_out");
  return status === "ready" ? undefined : problem("runtime_unavailable");
}
function installationMatches(
  binding: BindingScope["binding"],
  installation: BindingScope["installation"],
  agentId: string,
): boolean {
  if (binding.provider !== "slack") return true;
  return (
    installation?.status === "active" &&
    installation.credentialGeneration === binding.credentialGeneration &&
    installation.agentId === agentId
  );
}
function messagingConnected({ binding, installation }: BindingScope, now: Date): boolean {
  if (binding.provider === "slack") return Boolean(installation?.observedConnectedAt);
  return Boolean(
    binding.observedConnectedAt && binding.connectionLeaseExpiresAt && binding.connectionLeaseExpiresAt > now,
  );
}
function credentialProblem(credential: { timedOut?: boolean; reason?: string }): AgentStatusReason {
  if (credential.timedOut) return "credential_validation_timeout";
  if (credential.reason === "rate_limited") return "credential_rate_limited";
  // The provider could not answer, so the check says nothing about the credential.
  if (credential.reason === "provider_unreachable") return "credential_provider_unreachable";
  return "credential_validation_failed";
}

function computerOnline(computer: typeof computers.$inferSelect | undefined, registry: ConnectionRegistry): boolean {
  return (
    computer?.kind === "cloud" ||
    Boolean(
      computer?.currentInstanceId && !computer.disconnectedAt && registry.connectionStatus(computer.id) === "online",
    )
  );
}
