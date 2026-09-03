/**
 * The Agent Setup seam against an in-memory model of the Server, so the surface can be exercised —
 * in tests and, later, in the Review Lab — without one.
 *
 * This is a model of the flow, not a fake of the transport: it holds the facts a Server would
 * (the Computer's reachability, the runtime's readiness, the Messaging binding and any open
 * authorization attempt), derives the canonical snapshot from them on every read, and moves only
 * when the surface acts or the outside world does. The events a person performs away from the
 * page — scanning a code, finishing in Slack, a machine waking up — are explicit controls, because
 * no timer should decide when a state under review changes.
 *
 * Every read is validated against `AgentSetupSnapshotSchema` before it leaves. Durable states match
 * the Server projection. The one deliberate presentation-only superset is `slack-install`: it lets
 * Review Lab show the browser-away interval after Slack navigation, while production cannot observe
 * that interval because the callback activates the binding before returning to the application.
 */

import {
  type AccountComputerSummary,
  type AgentSetupAction,
  type AgentSetupBlocker,
  type AgentSetupComputerState,
  type AgentSetupMessagingBlockerCode,
  type AgentSetupMessagingState,
  type AgentSetupRuntimeState,
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  type AgentSetupStage,
  type AgentSummary,
  type ComputerConnectCodeStatus,
  type FeishuSetupIntent,
  type ImBindingMessagingExpectation,
  type ImCliReadinessStatus,
  type ImProvider,
  type ProviderReadinessStatus,
  type SlackConfigurationIntent,
} from "@opentag/shared/browser";
import type { AgentComputerInventoryAdapter } from "../features/agents/agent-computer-choice.js";
import type { ComputerConnectAdapter, ComputerConnectIntent } from "../features/computer-connect/computer-connect.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";

/** How long an issued authorization waits for the outside world, matching the Server's attempts. */
const ATTEMPT_TTL_MS = 10 * 60_000;
/** Shown as the Feishu QR target; it goes nowhere, because scanning it is a control here. */
const MEMORY_QR_URL = "https://accounts.feishu.cn/device?code=memory";

/**
 * Messaging as the outside world knows it. `reachable` is the Server's own observation of the
 * messaging identity (`waiting-handoff` until it lands, `ready` after); `attention` is a binding
 * that exists but needs the reader, mapped one-to-one onto the snapshot's blocked codes.
 */
export type MemoryMessagingModel =
  | { readonly kind: "not-configured" }
  | {
      readonly kind: "bound";
      readonly provider: ImProvider;
      readonly reachable?: boolean;
      readonly attention?: AgentSetupMessagingBlockerCode;
    };

export interface MemorySetupSeed {
  /**
   * The exact Agent, as the Account summary knows it. `agent.computer` decides the Computer leg:
   * `null` is not-bound; `requiresComputerRebind` keeps the stale identity visible while the
   * reader chooses a Computer that this Account owns.
   */
  readonly agent: AgentSummary;
  /** The Account inventory used by Computer choice and connect flows in Review Lab. */
  readonly computers?: readonly AccountComputerSummary[];
  /** Only meaningful for a bound Computer; defaults to reachable. */
  readonly computerOnline?: boolean;
  /** Defaults to ready, so a seed names only the legs it wants to exercise. */
  readonly runtimeStatus?: ProviderReadinessStatus;
  /** Independent daemon observations for both messaging CLIs; absent Providers are still checking. */
  readonly imCliReadiness?: Partial<Record<ImProvider, ImCliReadinessStatus>>;
  readonly messaging?: MemoryMessagingModel;
  /** Keeps one authoritative observation leg failed, for production-parity blocker scenarios. */
  readonly observationFailure?: "computer" | "runtime" | "messaging";
}

/** The outside world's moves. Each throws when there is nothing for it to move. */
export interface MemorySetupControls {
  /** The phone scan happened: the open Feishu attempt succeeds against its intent. */
  readonly scanFeishuCode: () => void;
  /** The open Feishu attempt expired or was refused. */
  readonly failFeishuAttempt: () => void;
  /** The open Slack install expired or was refused before its callback returned. */
  readonly failSlackInstall: () => void;
  /** The reader came back from Slack having installed (or reauthorized) the App. */
  readonly completeSlackInstall: () => void;
  /** The Server observed the messaging identity: `waiting-handoff` becomes `ready`. */
  readonly completeHandoff: () => void;
  /** The daemon redeemed the currently issued Computer command and came online. */
  readonly completeComputerConnection: () => void;
  /** The currently issued Computer command reached a terminal unusable state. */
  readonly expireComputerConnection: () => void;
  readonly setComputerOnline: (online: boolean) => void;
  readonly setImCliReadiness: (provider: ImProvider, status: ImCliReadinessStatus) => void;
  readonly setObservationFailure: (resource: MemorySetupSeed["observationFailure"]) => void;
  readonly setRuntimeStatus: (status: ProviderReadinessStatus) => void;
  /** Mirrors a successful `opentag doctor --json` observation across every readiness leg. */
  readonly runDoctor: () => void;
}

export interface MemorySetupAdapter {
  readonly adapter: AgentSetupAdapter;
  readonly computerAdapter: {
    readonly connect: ComputerConnectAdapter;
    readonly inventory: AgentComputerInventoryAdapter;
  };
  readonly controls: MemorySetupControls;
  /** A stable revision for React's external-store subscription. */
  readonly getVersion: () => number;
  readonly inspect: () => {
    readonly computerConnectState: ComputerConnectCodeStatus["state"] | undefined;
    readonly snapshot: AgentSetupSnapshot;
  };
  readonly subscribe: (listener: () => void) => () => void;
}

type MemoryMessagingState =
  | { kind: "not-configured" }
  | {
      kind: "feishu-attempt";
      attemptId: string;
      bindingId: string;
      intent: FeishuSetupIntent;
      prior: MemoryBoundMessaging;
    }
  | { kind: "slack-install"; intent: SlackConfigurationIntent; prior: MemoryBoundMessaging }
  | {
      kind: "bound";
      provider: ImProvider;
      bindingId: string;
      credentialGeneration: number;
      reachable: boolean;
      attention: AgentSetupMessagingBlockerCode | undefined;
    };

type MemoryBound = Extract<MemoryMessagingState, { kind: "bound" }>;
/** The binding an authorization attempt was maintaining, when there was one to come back to. */
type MemoryBoundMessaging = MemoryBound | undefined;

interface MemoryState {
  agent: AgentSummary;
  computerOnline: boolean;
  readonly computers: AccountComputerSummary[];
  connectAttempt: MemoryComputerConnectAttempt | undefined;
  readonly imCliReadiness: Partial<Record<ImProvider, ImCliReadinessStatus>>;
  runtimeStatus: ProviderReadinessStatus;
  messaging: MemoryMessagingState;
  observationFailure: MemorySetupSeed["observationFailure"];
}

interface MemoryComputerConnectAttempt {
  readonly intent: ComputerConnectIntent;
  status: ComputerConnectCodeStatus;
}

function now(): string {
  return new Date().toISOString();
}

function attemptExpiresAt(): string {
  return new Date(Date.now() + ATTEMPT_TTL_MS).toISOString();
}

function deriveMessaging(state: MemoryMessagingState): AgentSetupMessagingState {
  switch (state.kind) {
    case "not-configured":
      return { kind: "not-configured" };
    case "feishu-attempt":
      return {
        kind: "authorizing",
        provider: "feishu",
        attemptId: state.attemptId,
        qrUrl: MEMORY_QR_URL,
        expiresAt: attemptExpiresAt(),
      };
    // Review Lab only: production leaves the application for this interval and therefore never
    // returns this authorizing state from the setup endpoint.
    case "slack-install":
      return { kind: "authorizing", provider: "slack", expiresAt: attemptExpiresAt() };
    case "bound":
      if (state.attention) {
        return {
          kind: "blocked",
          provider: state.provider,
          bindingId: state.bindingId,
          credentialGeneration: state.credentialGeneration,
          code: state.attention,
          errorCode: null,
        };
      }
      return state.reachable
        ? {
            kind: "ready",
            provider: state.provider,
            bindingId: state.bindingId,
            credentialGeneration: state.credentialGeneration,
          }
        : {
            kind: "waiting-handoff",
            provider: state.provider,
            bindingId: state.bindingId,
            credentialGeneration: state.credentialGeneration,
          };
  }
}

function deriveBlockers(
  stage: AgentSetupStage,
  snapshot: { computer: AgentSetupComputerState; runtime: AgentSetupRuntimeState; messaging: AgentSetupMessagingState },
): AgentSetupBlocker[] {
  const { computer, runtime, messaging } = snapshot;
  if (computer.kind === "not-bound") return [{ code: "computer-not-bound" }];
  if (computer.kind === "observation-failed") {
    return [{ code: "resource-observation-failed", resource: "computer" }];
  }
  if (computer.kind === "requires-rebind") return [{ code: "computer-rebind-required" }];
  if (computer.connectionStatus === "offline") return [{ code: "computer-offline", computerId: computer.computerId }];
  if (stage === "needs-runtime" && runtime.kind === "observed" && runtime.status !== "ready") {
    return [{ code: "runtime-not-ready", provider: runtime.provider, status: runtime.status }];
  }
  if (runtime.kind === "observation-failed") {
    return [{ code: "resource-observation-failed", resource: "runtime" }];
  }
  if (messaging.kind === "observation-failed") {
    return [{ code: "resource-observation-failed", resource: "messaging" }];
  }
  if (messaging.kind === "not-configured") return [{ code: "messaging-not-configured" }];
  if (messaging.kind === "ready") return [];
  return [messagingBlocker(messaging)];
}

function messagingBlocker(
  messaging: Exclude<
    AgentSetupMessagingState,
    { kind: "not-configured" } | { kind: "observation-failed" } | { kind: "ready" }
  >,
): AgentSetupBlocker {
  if (messaging.kind === "blocked") {
    return {
      code: "messaging-not-ready",
      provider: messaging.provider,
      bindingId: messaging.bindingId,
      state: "blocked",
    };
  }
  if (messaging.kind === "waiting-handoff") {
    return {
      code: "messaging-not-ready",
      provider: messaging.provider,
      bindingId: messaging.bindingId,
      state: "waiting-handoff",
    };
  }
  return { code: "messaging-not-ready", provider: messaging.provider, state: messaging.kind };
}

function deriveBoundActions(messaging: MemoryBound): AgentSetupAction[] {
  if (messaging.attention === "authorization-failed") {
    return [{ kind: "unbind-messaging", provider: messaging.provider, bindingId: messaging.bindingId }];
  }
  if (!messaging.reachable && !messaging.attention) {
    return [
      { kind: "refresh" },
      { kind: "unbind-messaging", provider: messaging.provider, bindingId: messaging.bindingId },
    ];
  }
  const actions: AgentSetupAction[] = [
    {
      kind: "reauthorize-messaging",
      provider: messaging.provider,
      bindingId: messaging.bindingId,
      credentialGeneration: messaging.credentialGeneration,
    },
  ];
  if (messaging.provider === "feishu") {
    actions.push({
      kind: "replace-messaging",
      provider: "feishu",
      bindingId: messaging.bindingId,
      credentialGeneration: messaging.credentialGeneration,
    });
  }
  actions.push({ kind: "unbind-messaging", provider: messaging.provider, bindingId: messaging.bindingId });
  return actions;
}

function deriveMessagingActions(messaging: MemoryMessagingState): AgentSetupAction[] {
  switch (messaging.kind) {
    case "not-configured":
      return [
        { kind: "start-messaging", provider: "slack" },
        { kind: "start-messaging", provider: "feishu" },
      ];
    case "feishu-attempt":
      return [{ kind: "cancel-messaging-attempt", provider: "feishu", attemptId: messaging.attemptId }];
    case "slack-install":
      return [{ kind: "refresh" }];
    case "bound":
      return deriveBoundActions(messaging);
  }
}

function deriveActions(state: MemoryState): AgentSetupAction[] {
  const { agent, computerOnline, observationFailure, runtimeStatus, messaging } = state;
  if (observationFailure === "computer") return [{ kind: "refresh" }];
  if (agent.computer === null) return [{ kind: "bind-computer" }];
  if (agent.requiresComputerRebind === true) {
    return [{ kind: "bind-computer" }];
  }
  if (!computerOnline) {
    return [{ kind: "refresh" }, { kind: "repair-computer", computerId: agent.computer.computerId }];
  }
  if (observationFailure === "runtime") return [{ kind: "refresh" }];
  if (runtimeStatus !== "ready") return [{ kind: "refresh" }];
  if (observationFailure === "messaging") return [{ kind: "refresh" }];
  return deriveMessagingActions(messaging);
}

function deriveComputerState(state: MemoryState): AgentSetupComputerState {
  const { agent, computerOnline } = state;
  if (agent.computer === null) return { kind: "not-bound" };
  if (state.observationFailure === "computer") return { kind: "observation-failed", ...agent.computer };
  if (agent.requiresComputerRebind === true) return { kind: "requires-rebind", ...agent.computer };
  return {
    kind: "bound",
    ...agent.computer,
    connectionStatus: computerOnline ? "online" : "offline",
    imCliReadiness: (["feishu", "slack"] as const).map((provider) => ({
      provider,
      status: computerOnline ? (state.imCliReadiness[provider] ?? "checking") : "unavailable",
      observedAt: computerOnline && state.imCliReadiness[provider] ? now() : null,
    })),
    lastSeenAt: computerOnline ? null : now(),
    observedAt: now(),
  };
}

function deriveRuntimeState(state: MemoryState): AgentSetupRuntimeState {
  const provider = state.agent.runtimeProvider;
  if (state.agent.computer === null) return { kind: "unavailable", provider, reason: "computer-not-bound" };
  if (state.observationFailure === "computer") {
    return { kind: "unavailable", provider, reason: "computer-observation-failed" };
  }
  if (state.agent.requiresComputerRebind === true) {
    return { kind: "unavailable", provider, reason: "computer-rebind-required" };
  }
  if (!state.computerOnline) return { kind: "unavailable", provider, reason: "computer-offline" };
  if (state.observationFailure === "runtime") return { kind: "observation-failed", provider };
  return { kind: "observed", provider, status: state.runtimeStatus, observedAt: now() };
}

function deriveStage(
  computer: AgentSetupComputerState,
  runtime: AgentSetupRuntimeState,
  messaging: AgentSetupMessagingState,
): AgentSetupStage {
  if (computer.kind !== "bound" || computer.connectionStatus === "offline") return "needs-computer";
  if (runtime.kind !== "observed" || runtime.status !== "ready") return "needs-runtime";
  return messaging.kind === "ready" ? "ready" : "needs-messaging";
}

function deriveSnapshot(state: MemoryState): AgentSetupSnapshot {
  const computer = deriveComputerState(state);
  const runtime = deriveRuntimeState(state);
  const messaging: AgentSetupMessagingState =
    state.observationFailure === "messaging" ? { kind: "observation-failed" } : deriveMessaging(state.messaging);
  const stage = deriveStage(computer, runtime, messaging);
  return AgentSetupSnapshotSchema.parse({
    agent: state.agent,
    stage,
    computer,
    runtime,
    messaging,
    blockers: stage === "ready" ? [] : deriveBlockers(stage, { computer, runtime, messaging }),
    actions: deriveActions(state),
    observedAt: now(),
  });
}

function readBoundMessaging(state: MemoryState, operation: string): MemoryBound {
  if (state.messaging.kind !== "bound") {
    throw new Error(`${operation} requires a current Messaging binding`);
  }
  return state.messaging;
}

function assertExpectedMessaging(state: MemoryState, expected: ImBindingMessagingExpectation, operation: string): void {
  const current = state.messaging.kind === "bound" ? state.messaging : undefined;
  if (expected.kind === "unbound") {
    if (current) throw new Error(`${operation} was decided from a stale unbound state`);
    return;
  }
  if (
    !current ||
    current.provider !== expected.provider ||
    current.bindingId !== expected.bindingId ||
    current.credentialGeneration !== expected.credentialGeneration
  ) {
    throw new Error(`${operation} does not name the current Messaging binding generation`);
  }
}

const MEMORY_CONNECT_TTL_SECONDS = 15 * 60;
const MEMORY_CONNECTED_AT = "2026-09-01T10:00:00.000Z";

function computerFromAgent(agent: AgentSummary, online: boolean): AccountComputerSummary | undefined {
  if (!agent.computer || agent.requiresComputerRebind === true) return undefined;
  return {
    computerId: agent.computer.computerId,
    displayName: agent.computer.displayName,
    platform: agent.computer.platform,
    connectionStatus: online ? "online" : "offline",
    connectedAt: online ? MEMORY_CONNECTED_AT : null,
    lastSeenAt: online ? null : MEMORY_CONNECTED_AT,
    observedAt: MEMORY_CONNECTED_AT,
    createdAt: MEMORY_CONNECTED_AT,
    agentIds: [agent.id],
  };
}

function connectedComputer(intent: ComputerConnectIntent, state: MemoryState): AccountComputerSummary {
  const repaired =
    intent.mode === "repair"
      ? state.computers.find((computer) => computer.computerId === intent.target.computerId)
      : undefined;
  const computerId = intent.mode === "repair" ? intent.target.computerId : crypto.randomUUID();
  const displayName = intent.mode === "repair" ? intent.target.displayName : "Review Mac";
  return {
    computerId,
    displayName,
    platform: repaired?.platform ?? "darwin",
    connectionStatus: "online",
    connectedAt: now(),
    lastSeenAt: null,
    observedAt: now(),
    createdAt: repaired?.createdAt ?? now(),
    agentIds: repaired?.agentIds ?? [],
  };
}

function setMemoryComputerOnline(state: MemoryState, online: boolean): void {
  state.computerOnline = online;
  const computerId = state.agent.computer?.computerId;
  if (!computerId) return;
  const index = state.computers.findIndex((computer) => computer.computerId === computerId);
  const current = state.computers[index];
  if (!current) return;
  state.computers[index] = {
    ...current,
    connectionStatus: online ? "online" : "offline",
    connectedAt: online ? now() : current.connectedAt,
    lastSeenAt: online ? null : now(),
    observedAt: now(),
  };
}

export function createMemorySetupAdapter(seed: MemorySetupSeed): MemorySetupAdapter {
  const bound = seed.messaging?.kind === "bound" ? seed.messaging : undefined;
  const seededComputer = computerFromAgent(seed.agent, seed.computerOnline ?? true);
  const state: MemoryState = {
    agent: seed.agent,
    computerOnline: seed.computerOnline ?? true,
    computers: [...(seed.computers ?? (seededComputer ? [seededComputer] : []))],
    connectAttempt: undefined,
    imCliReadiness: { ...(seed.imCliReadiness ?? {}) },
    runtimeStatus: seed.runtimeStatus ?? "ready",
    messaging: bound
      ? {
          kind: "bound",
          provider: bound.provider,
          bindingId: crypto.randomUUID(),
          credentialGeneration: 1,
          reachable: bound.reachable ?? false,
          attention: bound.attention,
        }
      : { kind: "not-configured" },
    observationFailure: seed.observationFailure,
  };
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  const adapter: AgentSetupAdapter = {
    readSnapshot: async (agentId) => {
      if (agentId !== state.agent.id) throw new Error(`No such Agent: ${agentId}`);
      return deriveSnapshot(state);
    },
    startFeishuAttempt: async (agentId, intent, expectedMessaging) => {
      if (agentId !== state.agent.id) throw new Error(`No such Agent: ${agentId}`);
      assertExpectedMessaging(state, expectedMessaging, `${intent} ${messagingProviderLabel("feishu")}`);
      const prior = state.messaging.kind === "bound" ? state.messaging : undefined;
      if (intent === "create" && state.messaging.kind !== "not-configured") {
        throw new Error("A Messaging Provider can be started only from not-configured");
      }
      if (intent !== "create" && prior?.provider !== "feishu") {
        throw new Error(`${intent} requires the current ${messagingProviderLabel("feishu")} binding`);
      }
      state.messaging = {
        kind: "feishu-attempt",
        attemptId: crypto.randomUUID(),
        bindingId: prior?.bindingId ?? crypto.randomUUID(),
        intent,
        prior,
      };
      changed();
    },
    cancelFeishuAttempt: async (attemptId) => {
      if (state.messaging.kind !== "feishu-attempt" || state.messaging.attemptId !== attemptId) {
        throw new Error(`No open ${messagingProviderLabel("feishu")} attempt: ${attemptId}`);
      }
      const { bindingId, prior } = state.messaging;
      state.messaging =
        prior ??
        ({
          kind: "bound",
          provider: "feishu",
          bindingId,
          credentialGeneration: 0,
          reachable: false,
          attention: "authorization-failed",
        } satisfies MemoryBound);
      changed();
    },
    startSlackInstall: async (agentId, intent, expectedMessaging) => {
      if (agentId !== state.agent.id) throw new Error(`No such Agent: ${agentId}`);
      assertExpectedMessaging(state, expectedMessaging, `${intent} ${messagingProviderLabel("slack")}`);
      const prior = state.messaging.kind === "bound" ? state.messaging : undefined;
      if (intent === "create" && state.messaging.kind !== "not-configured") {
        throw new Error(
          `${messagingProviderLabel("slack")} install requires the Agent to be unbound; unbind before a fresh install`,
        );
      }
      if (intent === "reauthorize" && prior?.provider !== "slack") {
        const provider = messagingProviderLabel("slack");
        throw new Error(`${provider} reauthorization requires the current ${provider} binding`);
      }
      state.messaging = { kind: "slack-install", intent, prior };
      changed();
      return `https://slack.com/oauth/v2/authorize?state=memory-${encodeURIComponent(agentId)}`;
    },
    unbindMessaging: async (agentId, provider, bindingId) => {
      if (agentId !== state.agent.id) throw new Error(`No such Agent: ${agentId}`);
      const current = readBoundMessaging(state, "unbind");
      if (current.bindingId !== bindingId || current.provider !== provider) {
        throw new Error(`Binding ${bindingId} is not the current binding`);
      }
      state.messaging = { kind: "not-configured" };
      changed();
    },
  };

  const computerConnectAdapter: ComputerConnectAdapter = {
    issue: async (intent) => {
      const connectCodeId = crypto.randomUUID();
      const issuedAt = now();
      state.connectAttempt = {
        intent,
        status: { connectCodeId, state: "pending", computerId: null, redeemedAt: null },
      };
      changed();
      return {
        bootstrapCommand: `opentag connect --server https://opentag.ai -- memory-${connectCodeId}`,
        connectCodeId,
        expiresIn: MEMORY_CONNECT_TTL_SECONDS,
        issuedAt,
      };
    },
    status: async (connectCodeId) => {
      const attempt = state.connectAttempt;
      if (!attempt || attempt.status.connectCodeId !== connectCodeId) {
        throw new Error(`No Computer connect command: ${connectCodeId}`);
      }
      return attempt.status;
    },
    computers: async () => ({ computers: state.computers }),
  };

  const computerInventoryAdapter: AgentComputerInventoryAdapter = {
    computers: async () => ({ computers: state.computers }),
    bindComputer: async (agentId, computerId) => {
      if (agentId !== state.agent.id) throw new Error(`No such Agent: ${agentId}`);
      const computer = state.computers.find((candidate) => candidate.computerId === computerId);
      if (!computer) throw new Error(`No such Computer: ${computerId}`);
      state.agent = {
        ...state.agent,
        computer: {
          computerId: computer.computerId,
          displayName: computer.displayName,
          platform: computer.platform,
        },
        requiresComputerRebind: false,
      };
      state.computerOnline = computer.connectionStatus === "online";
      changed();
    },
  };

  const controls: MemorySetupControls = {
    scanFeishuCode: () => {
      if (state.messaging.kind !== "feishu-attempt") {
        throw new Error(`No ${messagingProviderLabel("feishu")} attempt is waiting for a scan`);
      }
      const { bindingId, intent, prior } = state.messaging;
      // A first connection still owes the Server's observation; a reauthorization or replace
      // returns to the binding it was maintaining, with the attention it was raised to clear gone.
      state.messaging =
        intent === "create" || prior === undefined
          ? {
              kind: "bound",
              provider: "feishu",
              bindingId,
              credentialGeneration: 1,
              reachable: false,
              attention: undefined,
            }
          : { ...prior, credentialGeneration: prior.credentialGeneration + 1, attention: undefined };
      changed();
    },
    failFeishuAttempt: () => {
      if (state.messaging.kind !== "feishu-attempt") {
        throw new Error(`No ${messagingProviderLabel("feishu")} attempt is open`);
      }
      const { bindingId, prior } = state.messaging;
      state.messaging =
        prior ??
        ({
          kind: "bound",
          provider: "feishu",
          bindingId,
          credentialGeneration: 0,
          reachable: false,
          attention: "authorization-failed",
        } satisfies MemoryBound);
      changed();
    },
    failSlackInstall: () => {
      if (state.messaging.kind !== "slack-install") {
        throw new Error(`No ${messagingProviderLabel("slack")} install is open`);
      }
      const { prior } = state.messaging;
      state.messaging =
        prior ??
        ({
          kind: "bound",
          provider: "slack",
          bindingId: crypto.randomUUID(),
          credentialGeneration: 0,
          reachable: false,
          attention: "authorization-failed",
        } satisfies MemoryBound);
      changed();
    },
    completeSlackInstall: () => {
      if (state.messaging.kind !== "slack-install") {
        throw new Error(`No ${messagingProviderLabel("slack")} install is waiting`);
      }
      const { intent, prior } = state.messaging;
      state.messaging =
        intent === "create" || prior === undefined
          ? {
              kind: "bound",
              provider: "slack",
              bindingId: crypto.randomUUID(),
              credentialGeneration: 1,
              reachable: false,
              attention: undefined,
            }
          : { ...prior, credentialGeneration: prior.credentialGeneration + 1, attention: undefined };
      changed();
    },
    completeHandoff: () => {
      const boundState = readBoundMessaging(state, "handoff");
      if (boundState.reachable) throw new Error("The messaging identity is already observed");
      state.messaging = { ...boundState, reachable: true };
      changed();
    },
    completeComputerConnection: () => {
      const attempt = state.connectAttempt;
      if (attempt?.status.state !== "pending") {
        throw new Error("No Computer connect command is waiting");
      }
      const computer = connectedComputer(attempt.intent, state);
      state.computers.splice(
        0,
        state.computers.length,
        ...state.computers.filter((candidate) => candidate.computerId !== computer.computerId),
        computer,
      );
      if (state.agent.computer?.computerId === computer.computerId) state.computerOnline = true;
      attempt.status = {
        connectCodeId: attempt.status.connectCodeId,
        state: "redeemed",
        computerId: computer.computerId,
        redeemedAt: computer.connectedAt ?? now(),
      };
      changed();
    },
    expireComputerConnection: () => {
      const attempt = state.connectAttempt;
      if (attempt?.status.state !== "pending") {
        throw new Error("No Computer connect command is waiting");
      }
      attempt.status = {
        connectCodeId: attempt.status.connectCodeId,
        state: "expired",
        computerId: null,
        redeemedAt: null,
      };
      changed();
    },
    setComputerOnline: (online) => {
      setMemoryComputerOnline(state, online);
      changed();
    },
    setImCliReadiness: (provider, status) => {
      state.imCliReadiness[provider] = status;
      changed();
    },
    setObservationFailure: (resource) => {
      state.observationFailure = resource;
      changed();
    },
    setRuntimeStatus: (status) => {
      state.runtimeStatus = status;
      changed();
    },
    runDoctor: () => {
      state.computerOnline = true;
      state.runtimeStatus = "ready";
      state.imCliReadiness.feishu = "ready";
      state.imCliReadiness.slack = "ready";
      state.observationFailure = undefined;
      changed();
    },
  };

  return {
    adapter,
    computerAdapter: { connect: computerConnectAdapter, inventory: computerInventoryAdapter },
    controls,
    getVersion: () => version,
    inspect: () => ({
      computerConnectState: state.connectAttempt?.status.state,
      snapshot: deriveSnapshot(state),
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
