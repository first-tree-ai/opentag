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
 * Every read is validated against `AgentSetupSnapshotSchema` before it leaves: a model that could
 * emit a snapshot the real Server never would would teach the surface the wrong lessons.
 */

import {
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
  type FeishuSetupIntent,
  type ImBindingMessagingExpectation,
  type ImProvider,
  type ProviderReadinessStatus,
  type SlackConfigurationIntent,
} from "@opentag/shared/browser";
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
   * `null` is not-bound, `requiresComputerRebind` keeps the identity and demands the repair.
   */
  readonly agent: AgentSummary;
  /** Only meaningful for a bound Computer; defaults to reachable. */
  readonly computerOnline?: boolean;
  /** Defaults to ready, so a seed names only the legs it wants to exercise. */
  readonly runtimeStatus?: ProviderReadinessStatus;
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
  /** The reader came back from Slack having installed (or reauthorized) the App. */
  readonly completeSlackInstall: () => void;
  /** The Server observed the messaging identity: `waiting-handoff` becomes `ready`. */
  readonly completeHandoff: () => void;
  readonly setComputerOnline: (online: boolean) => void;
  readonly setRuntimeStatus: (status: ProviderReadinessStatus) => void;
}

export interface MemorySetupAdapter {
  readonly adapter: AgentSetupAdapter;
  readonly controls: MemorySetupControls;
}

type MemoryMessagingState =
  | { kind: "not-configured" }
  | { kind: "feishu-attempt"; attemptId: string; intent: FeishuSetupIntent; prior: MemoryBoundMessaging }
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
  readonly agent: AgentSummary;
  computerOnline: boolean;
  runtimeStatus: ProviderReadinessStatus;
  messaging: MemoryMessagingState;
  readonly observationFailure: MemorySetupSeed["observationFailure"];
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
        { kind: "start-messaging", provider: "feishu" },
        { kind: "start-messaging", provider: "slack" },
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
    return [{ kind: "repair-computer", computerId: agent.computer.computerId }];
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

export function createMemorySetupAdapter(seed: MemorySetupSeed): MemorySetupAdapter {
  const bound = seed.messaging?.kind === "bound" ? seed.messaging : undefined;
  const state: MemoryState = {
    agent: seed.agent,
    computerOnline: seed.computerOnline ?? true,
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
      state.messaging = { kind: "feishu-attempt", attemptId: crypto.randomUUID(), intent, prior };
    },
    cancelFeishuAttempt: async (attemptId) => {
      if (state.messaging.kind !== "feishu-attempt" || state.messaging.attemptId !== attemptId) {
        throw new Error(`No open ${messagingProviderLabel("feishu")} attempt: ${attemptId}`);
      }
      const prior = state.messaging.prior;
      state.messaging = prior ?? { kind: "not-configured" };
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
      return `https://slack.com/oauth/v2/authorize?state=memory-${encodeURIComponent(agentId)}`;
    },
    unbindMessaging: async (agentId, provider, bindingId) => {
      if (agentId !== state.agent.id) throw new Error(`No such Agent: ${agentId}`);
      const current = readBoundMessaging(state, "unbind");
      if (current.bindingId !== bindingId || current.provider !== provider) {
        throw new Error(`Binding ${bindingId} is not the current binding`);
      }
      state.messaging = { kind: "not-configured" };
    },
  };

  const controls: MemorySetupControls = {
    scanFeishuCode: () => {
      if (state.messaging.kind !== "feishu-attempt") {
        throw new Error(`No ${messagingProviderLabel("feishu")} attempt is waiting for a scan`);
      }
      const { intent, prior } = state.messaging;
      // A first connection still owes the Server's observation; a reauthorization or replace
      // returns to the binding it was maintaining, with the attention it was raised to clear gone.
      state.messaging =
        intent === "create" || prior === undefined
          ? {
              kind: "bound",
              provider: "feishu",
              bindingId: crypto.randomUUID(),
              credentialGeneration: 1,
              reachable: false,
              attention: undefined,
            }
          : { ...prior, credentialGeneration: prior.credentialGeneration + 1, attention: undefined };
    },
    failFeishuAttempt: () => {
      if (state.messaging.kind !== "feishu-attempt") {
        throw new Error(`No ${messagingProviderLabel("feishu")} attempt is open`);
      }
      const prior = state.messaging.prior;
      state.messaging = prior ?? { kind: "not-configured" };
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
    },
    completeHandoff: () => {
      const boundState = readBoundMessaging(state, "handoff");
      if (boundState.reachable) throw new Error("The messaging identity is already observed");
      state.messaging = { ...boundState, reachable: true };
    },
    setComputerOnline: (online) => {
      state.computerOnline = online;
    },
    setRuntimeStatus: (status) => {
      state.runtimeStatus = status;
    },
  };

  return { adapter, controls };
}
