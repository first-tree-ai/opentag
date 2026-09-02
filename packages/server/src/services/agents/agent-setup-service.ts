import type {
  AgentSetupAction,
  AgentSetupBlocker,
  AgentSetupComputerState,
  AgentSetupMessagingState,
  AgentSetupRuntimeState,
  AgentSetupSnapshot,
  AgentSetupStage,
  AgentSummary,
  FeishuSetupAttempt,
  ImProvider,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import {
  type ProviderReadinessSource,
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "../computers/index.js";
import type { AgentSetupBindingState } from "../im-bindings/index.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError } from "./errors.js";

class AgentSetupObservationError extends Error {}

/** Reads the Agent's exact current Messaging binding together with its live handoff readiness. */
export interface AgentSetupMessagingSource {
  getSetupBindingForAgent(callerUserId: string, agentId: string): Promise<AgentSetupBindingState | undefined>;
}

/** Observes the Agent-owned Feishu setup attempt with its expiry and owner-liveness projection. */
export interface AgentSetupAttemptSource {
  observeForAgent(agentId: string): Promise<FeishuSetupAttempt | undefined>;
}

export interface AgentSetupServiceOptions {
  now?: () => Date;
  presenceTimeoutMs?: number;
  providerReadiness?: ProviderReadinessSource;
  slackOAuthAvailable?: boolean;
}

/**
 * The exact-Agent setup read projection. Everything in the snapshot derives from authoritative
 * state at one observed instant: the Agent row and its exact Computer binding, the Computer's
 * reachability, the exact runtime Provider readiness observed on that Computer, and the Agent-owned
 * Messaging binding with its setup attempt or handoff. Nothing is persisted and no other Agent is
 * consulted, so an unbound Agent is a legal answer rather than a fallback to a list.
 */
export class AgentSetupService {
  readonly #agents: Pick<AgentService, "getById">;
  readonly #attempts: AgentSetupAttemptSource;
  readonly #database: DatabaseClient;
  readonly #messaging: AgentSetupMessagingSource;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;
  readonly #slackOAuthAvailable: boolean;

  constructor(
    database: DatabaseClient,
    agents: Pick<AgentService, "getById">,
    messaging: AgentSetupMessagingSource,
    attempts: AgentSetupAttemptSource,
    options: AgentSetupServiceOptions = {},
  ) {
    this.#database = database;
    this.#agents = agents;
    this.#messaging = messaging;
    this.#attempts = attempts;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
    this.#slackOAuthAvailable = options.slackOAuthAvailable ?? true;
  }

  async getSetupById(callerUserId: string, agentId: string): Promise<AgentSetupSnapshot> {
    const detail = await this.#agents.getById(callerUserId, agentId);
    if (detail.status !== "active") {
      throw new AgentServiceError(
        "AGENT_LIFECYCLE_CONFLICT",
        "deterministic",
        "Only an active Agent exposes a setup projection",
        409,
      );
    }
    const { activity: _activity, ...agent } = detail;
    const observedAt = this.#now();
    const computer = await this.#observeComputer(agent, observedAt);
    const runtime = this.#observeRuntime(agent.runtimeProvider, computer, observedAt);
    const messaging = await this.#observeMessaging(callerUserId, agentId);
    // Observation crosses runtime and Provider boundaries, so the Agent may change while those
    // reads are in flight. Revalidate the exact target after the last observation: a stale tab
    // must never receive an actionable snapshot for an Agent that is no longer active, and a
    // concurrent Agent mutation must be retried rather than projected as one mixed revision.
    const current = await this.#agents.getById(callerUserId, agentId);
    if (current.status !== "active") {
      throw new AgentServiceError(
        "AGENT_LIFECYCLE_CONFLICT",
        "deterministic",
        "Only an active Agent exposes a setup projection",
        409,
      );
    }
    if (
      current.updatedAt !== detail.updatedAt ||
      current.runtimeProvider !== detail.runtimeProvider ||
      current.computer?.computerId !== detail.computer?.computerId
    ) {
      throw new AgentServiceError(
        "AGENT_REVISION_CONFLICT",
        "deterministic",
        "The Agent changed while its setup state was observed",
        409,
      );
    }
    const stage = deriveSetupStage(computer, runtime, messaging);
    return {
      agent,
      stage,
      computer,
      runtime,
      messaging,
      blockers: deriveSetupBlockers(stage, computer, runtime, messaging),
      actions: deriveSetupActions(stage, computer, messaging, this.#slackOAuthAvailable),
      observedAt: observedAt.toISOString(),
    };
  }

  async #observeComputer(agent: AgentSummary, observedAt: Date): Promise<AgentSetupComputerState> {
    try {
      return await this.#computerState(agent, observedAt);
    } catch (cause) {
      if (!(cause instanceof AgentSetupObservationError)) throw cause;
      if (agent.computer === null) throw new Error("An unbound Agent cannot fail bound Computer observation");
      return { kind: "observation-failed", ...agent.computer };
    }
  }

  #observeRuntime(
    provider: AgentSummary["runtimeProvider"],
    computer: AgentSetupComputerState,
    observedAt: Date,
  ): AgentSetupRuntimeState {
    try {
      return runtimeStateFor(provider, computer, observedAt, this.#providerReadiness);
    } catch (cause) {
      if (!(cause instanceof AgentSetupObservationError)) throw cause;
      return { kind: "observation-failed", provider };
    }
  }

  async #observeMessaging(callerUserId: string, agentId: string): Promise<AgentSetupMessagingState> {
    try {
      return await this.#messagingState(callerUserId, agentId);
    } catch (cause) {
      if (!(cause instanceof AgentSetupObservationError)) throw cause;
      return { kind: "observation-failed" };
    }
  }

  async #computerState(agent: AgentSummary, observedAt: Date): Promise<AgentSetupComputerState> {
    if (agent.computer === null) return { kind: "not-bound" };
    const identity = {
      computerId: agent.computer.computerId,
      displayName: agent.computer.displayName,
      platform: agent.computer.platform,
    };
    if (agent.requiresComputerRebind === true) return { kind: "requires-rebind", ...identity };
    const [computer] = await this.#database
      .select({ currentInstanceId: computers.currentInstanceId, lastSeenAt: computers.lastSeenAt })
      .from(computers)
      .where(eq(computers.id, identity.computerId))
      .limit(1)
      .catch((cause: unknown) => {
        throw new AgentSetupObservationError("Computer observation failed", { cause });
      });
    if (!computer) throw new Error("Active Agent is missing its bound Computer");
    const connectionStatus =
      computer.currentInstanceId !== null &&
      (computer.lastSeenAt?.getTime() ?? 0) >= observedAt.getTime() - this.#presenceTimeoutMs
        ? ("online" as const)
        : ("offline" as const);
    return {
      kind: "bound",
      ...identity,
      connectionStatus,
      imCliReadiness: projectComputerImCliReadiness(
        identity.computerId,
        connectionStatus,
        observedAt,
        this.#providerReadiness,
      ),
      lastSeenAt: computer.lastSeenAt?.toISOString() ?? null,
      observedAt: observedAt.toISOString(),
    };
  }

  async #messagingState(callerUserId: string, agentId: string): Promise<AgentSetupMessagingState> {
    const binding = await this.#messaging.getSetupBindingForAgent(callerUserId, agentId).catch((cause: unknown) => {
      throw new AgentSetupObservationError("Messaging observation failed", { cause });
    });
    if (!binding) return { kind: "not-configured" };
    const attempt = binding.provider === "feishu" ? await this.#observeAttempt(agentId) : undefined;
    if (attempt && (attempt.state === "awaiting_user" || attempt.state === "validating")) {
      return {
        kind: "authorizing",
        provider: "feishu",
        attemptId: attempt.id,
        qrUrl: attempt.qrUrl,
        expiresAt: attempt.expiresAt,
      };
    }
    const { handoff } = binding;
    switch (handoff.bindingState) {
      case "active":
        return activeMessagingState(binding, handoff);
      case "reauthorization_required":
        return blockedMessagingState(binding, "reauthorization-required");
      case "error":
        return blockedMessagingState(binding, "provider-error");
      case "provisioning":
        return provisioningMessagingState(binding, attempt);
      default:
        throw new Error(`The Messaging binding handoff state cannot be projected: ${handoff.bindingState}`);
    }
  }

  async #observeAttempt(agentId: string): Promise<FeishuSetupAttempt | undefined> {
    return this.#attempts.observeForAgent(agentId).catch((cause: unknown) => {
      throw new AgentSetupObservationError("Messaging attempt observation failed", { cause });
    });
  }
}

function provisioningMessagingState(
  binding: AgentSetupBindingState,
  attempt: FeishuSetupAttempt | undefined,
): AgentSetupMessagingState {
  // The attempt is terminal (or no longer observable): the provisioning binding names it exactly
  // and the only way forward is to unbind it before a Provider can be started again.
  return {
    kind: "blocked",
    provider: binding.provider,
    bindingId: binding.bindingId,
    credentialGeneration: binding.credentialGeneration,
    code: "authorization-failed",
    errorCode: attempt?.errorCode ?? binding.errorCode,
  };
}

function activeMessagingState(
  binding: AgentSetupBindingState,
  handoff: Extract<AgentSetupBindingState["handoff"], { bindingState: "active" }>,
): AgentSetupMessagingState {
  if (handoff.handoffReady) {
    return {
      kind: "ready",
      provider: binding.provider,
      bindingId: binding.bindingId,
      credentialGeneration: binding.credentialGeneration,
    };
  }
  return {
    kind: "waiting-handoff",
    provider: binding.provider,
    bindingId: binding.bindingId,
    credentialGeneration: binding.credentialGeneration,
    ...(handoff.providerCli ? { progress: handoff.providerCli } : {}),
  };
}

function blockedMessagingState(
  binding: AgentSetupBindingState,
  code: "reauthorization-required" | "provider-error",
): AgentSetupMessagingState {
  return {
    kind: "blocked",
    provider: binding.provider,
    bindingId: binding.bindingId,
    credentialGeneration: binding.credentialGeneration,
    code,
    errorCode: binding.errorCode,
  };
}

function runtimeStateFor(
  provider: AgentSummary["runtimeProvider"],
  computer: AgentSetupComputerState,
  observedAt: Date,
  source?: ProviderReadinessSource,
): AgentSetupRuntimeState {
  if (computer.kind !== "bound" || computer.connectionStatus !== "online") {
    const reason =
      computer.kind === "not-bound"
        ? ("computer-not-bound" as const)
        : computer.kind === "observation-failed"
          ? ("computer-observation-failed" as const)
          : computer.kind === "requires-rebind"
            ? ("computer-rebind-required" as const)
            : ("computer-offline" as const);
    return { kind: "unavailable", provider, reason };
  }
  let readiness: ReturnType<typeof projectComputerProviderReadiness>;
  try {
    readiness = projectComputerProviderReadiness(computer.computerId, "online", observedAt, source);
  } catch (cause) {
    throw new AgentSetupObservationError("Runtime observation failed", { cause });
  }
  const exact = readiness.find((observation) => observation.provider === provider);
  if (!exact) throw new Error("The Agent's runtime Provider is not admitted by the server");
  return { kind: "observed", provider, status: exact.status, observedAt: exact.observedAt };
}

/** The same canonical order the shared contract validates: Computer, then runtime, then Messaging. */
function deriveSetupStage(
  computer: AgentSetupComputerState,
  runtime: AgentSetupRuntimeState,
  messaging: AgentSetupMessagingState,
): AgentSetupStage {
  const computerReady = computer.kind === "bound" && computer.connectionStatus === "online";
  if (!computerReady) return "needs-computer";
  const runtimeReady = runtime.kind === "observed" && runtime.status === "ready";
  if (!runtimeReady) return "needs-runtime";
  return messaging.kind === "ready" ? "ready" : "needs-messaging";
}

function deriveSetupBlockers(
  stage: AgentSetupStage,
  computer: AgentSetupComputerState,
  runtime: AgentSetupRuntimeState,
  messaging: AgentSetupMessagingState,
): AgentSetupBlocker[] {
  switch (stage) {
    case "needs-computer":
      return computerBlockers(computer);
    case "needs-runtime":
      return runtimeBlockers(runtime);
    case "needs-messaging":
      return messagingBlockers(messaging);
    case "ready":
      return [];
  }
}

function computerBlockers(computer: AgentSetupComputerState): AgentSetupBlocker[] {
  if (computer.kind === "not-bound") return [{ code: "computer-not-bound" }];
  if (computer.kind === "observation-failed") {
    return [{ code: "resource-observation-failed", resource: "computer" }];
  }
  if (computer.kind === "requires-rebind") return [{ code: "computer-rebind-required" }];
  return [{ code: "computer-offline", computerId: computer.computerId }];
}

function runtimeBlockers(runtime: AgentSetupRuntimeState): AgentSetupBlocker[] {
  if (runtime.kind === "observation-failed") {
    return [{ code: "resource-observation-failed", resource: "runtime" }];
  }
  if (runtime.kind !== "observed" || runtime.status === "ready") {
    throw new Error("A needs-runtime setup must carry an observed non-ready runtime");
  }
  return [{ code: "runtime-not-ready", provider: runtime.provider, status: runtime.status }];
}

function messagingBlockers(messaging: AgentSetupMessagingState): AgentSetupBlocker[] {
  if (messaging.kind === "not-configured") return [{ code: "messaging-not-configured" }];
  if (messaging.kind === "observation-failed") {
    return [{ code: "resource-observation-failed", resource: "messaging" }];
  }
  if (messaging.kind === "ready") {
    throw new Error("A needs-messaging setup cannot carry a ready Messaging binding");
  }
  const bindingId = "bindingId" in messaging ? messaging.bindingId : undefined;
  return [
    {
      code: "messaging-not-ready",
      provider: messaging.provider,
      ...(bindingId ? { bindingId } : {}),
      state: messaging.kind,
    },
  ];
}

function deriveSetupActions(
  stage: AgentSetupStage,
  computer: AgentSetupComputerState,
  messaging: AgentSetupMessagingState,
  slackOAuthAvailable: boolean,
): AgentSetupAction[] {
  switch (stage) {
    case "needs-computer":
      if (computer.kind === "observation-failed") return [{ kind: "refresh" }];
      if (computer.kind === "not-bound" || computer.kind === "requires-rebind") {
        return [{ kind: "bind-computer" }];
      }
      return [{ kind: "refresh" }, { kind: "repair-computer", computerId: computer.computerId }];
    case "needs-runtime":
      return [{ kind: "refresh" }];
    case "needs-messaging":
    case "ready":
      return messagingActions(messaging, slackOAuthAvailable);
  }
}

/**
 * The actions a Messaging state may offer. There is deliberately no direct Provider switch: while a
 * binding is current the only way toward another Provider is `unbind-messaging`, after which the
 * projection returns to not-configured and `start-messaging` becomes legal. Same-Provider
 * reauthorization (and Feishu replacement) stays available because it names the exact binding.
 */
function messagingActions(messaging: AgentSetupMessagingState, slackOAuthAvailable: boolean): AgentSetupAction[] {
  switch (messaging.kind) {
    case "not-configured": {
      const actions: AgentSetupAction[] = [{ kind: "start-messaging", provider: "feishu" }];
      if (slackOAuthAvailable) actions.push({ kind: "start-messaging", provider: "slack" });
      return actions;
    }
    case "observation-failed":
      return [{ kind: "refresh" }];
    case "authorizing":
      if (messaging.provider !== "feishu") return [{ kind: "refresh" }];
      return [{ kind: "cancel-messaging-attempt", provider: "feishu", attemptId: messaging.attemptId }];
    case "waiting-handoff":
      return [
        { kind: "refresh" },
        { kind: "unbind-messaging", provider: messaging.provider, bindingId: messaging.bindingId },
      ];
    case "blocked":
      if (messaging.code === "authorization-failed") {
        if (!messaging.bindingId) throw new Error("A failed Messaging authorization must name its binding");
        return [{ kind: "unbind-messaging", provider: messaging.provider, bindingId: messaging.bindingId }];
      }
      if (!messaging.bindingId) throw new Error("A blocked Messaging binding must name its binding");
      if (!messaging.credentialGeneration) {
        throw new Error("A configured blocked Messaging binding must name its credential generation");
      }
      return currentBindingActions(
        messaging.provider,
        messaging.bindingId,
        messaging.credentialGeneration,
        slackOAuthAvailable,
      );
    case "ready":
      return currentBindingActions(
        messaging.provider,
        messaging.bindingId,
        messaging.credentialGeneration,
        slackOAuthAvailable,
      );
  }
}

function currentBindingActions(
  provider: ImProvider,
  bindingId: string,
  credentialGeneration: number,
  slackOAuthAvailable: boolean,
): AgentSetupAction[] {
  const actions: AgentSetupAction[] = [];
  if (provider !== "slack" || slackOAuthAvailable) {
    actions.push({ kind: "reauthorize-messaging", provider, bindingId, credentialGeneration });
  }
  if (provider === "feishu") {
    actions.push({ kind: "replace-messaging", provider: "feishu", bindingId, credentialGeneration });
  }
  actions.push({ kind: "unbind-messaging", provider, bindingId });
  return actions;
}
