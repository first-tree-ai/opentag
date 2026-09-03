import { z } from "zod";
import { AgentSummarySchema } from "./agent.js";
import {
  ComputerConnectionStatusSchema,
  type ComputerImCliReadiness,
  type ComputerImCliReadinessCollection,
  ComputerImCliReadinessCollectionSchema,
  ComputerPlatformSchema,
  type ImCliProvider,
  ImCliProviderSchema,
  ProviderReadinessStatusSchema,
} from "./computer.js";
import { ImProviderSchema, ProviderCliHandoffProgressSchema, SlackConfigurationIntentSchema } from "./im-binding.js";

export const AGENT_SETUP_STAGES = [
  "needs-computer",
  "needs-runtime",
  "needs-provider-clis",
  "needs-messaging",
  "ready",
] as const;
export const AgentSetupStageSchema = z.enum(AGENT_SETUP_STAGES);

/**
 * The IM CLI Providers that must be freshly ready on the setup Computer before a not-configured
 * Messaging state may advance. The order is canonical: Server snapshots, component projections, and
 * consumers must never reorder or subset this set on their own.
 */
export const AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS = ["feishu", "slack"] as const;

const AgentSetupComputerIdentityShape = {
  computerId: z.string().uuid(),
  displayName: z.string().min(1),
  platform: ComputerPlatformSchema,
};

export const AgentSetupComputerStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-bound") }).strict(),
  z
    .object({
      kind: z.literal("observation-failed"),
      ...AgentSetupComputerIdentityShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("requires-rebind"),
      ...AgentSetupComputerIdentityShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bound"),
      ...AgentSetupComputerIdentityShape,
      connectionStatus: ComputerConnectionStatusSchema,
      imCliReadiness: ComputerImCliReadinessCollectionSchema,
      lastSeenAt: z.string().datetime().nullable(),
      observedAt: z.string().datetime(),
    })
    .strict(),
]);

export const AgentSetupRuntimeUnavailableReasonSchema = z.enum([
  "computer-not-bound",
  "computer-observation-failed",
  "computer-rebind-required",
  "computer-offline",
]);

export const AgentSetupRuntimeStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observation-failed"),
      provider: AgentSummarySchema.shape.runtimeProvider,
    })
    .strict(),
  z
    .object({
      /** No fresh readiness report exists for the exact runtime Provider on the online Computer. */
      kind: z.literal("waiting"),
      provider: AgentSummarySchema.shape.runtimeProvider,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      provider: AgentSummarySchema.shape.runtimeProvider,
      reason: AgentSetupRuntimeUnavailableReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("observed"),
      provider: AgentSummarySchema.shape.runtimeProvider,
      status: ProviderReadinessStatusSchema,
      /** An observed report always carries its observation time; a ready report cannot lack evidence. */
      observedAt: z.string().datetime(),
    })
    .strict(),
]);

/**
 * The local-preparation component vocabulary. Existing wire statuses are reused verbatim wherever a
 * report exists; `waiting` is the only new word and means "no fresh report yet", never a fabricated
 * checking state.
 */
export const AGENT_SETUP_COMPUTER_COMPONENT_STATUSES = [
  "not-bound",
  "requires-rebind",
  "observation-failed",
  "offline",
  "online",
] as const;
export const AGENT_SETUP_RUNTIME_COMPONENT_STATUSES = [
  "observation-failed",
  "waiting",
  "checking",
  "install",
  "sign-in",
  "ready",
  "unavailable",
] as const;
export const AGENT_SETUP_IM_CLI_COMPONENT_STATUSES = [
  "waiting",
  "checking",
  "install",
  "ready",
  "unavailable",
] as const;

export const AgentSetupComputerComponentStatusSchema = z.enum(AGENT_SETUP_COMPUTER_COMPONENT_STATUSES);
export const AgentSetupRuntimeComponentStatusSchema = z.enum(AGENT_SETUP_RUNTIME_COMPONENT_STATUSES);
export const AgentSetupImCliComponentStatusSchema = z.enum(AGENT_SETUP_IM_CLI_COMPONENT_STATUSES);

const AgentSetupComputerComponentSchema = z
  .object({
    kind: z.literal("computer"),
    status: AgentSetupComputerComponentStatusSchema,
    /** Whether this leg currently blocks the setup cursor. */
    blocking: z.boolean(),
    computerId: z.string().uuid().nullable(),
    displayName: z.string().min(1).nullable(),
    platform: ComputerPlatformSchema.nullable(),
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

const AgentSetupRuntimeComponentSchema = z
  .object({
    kind: z.literal("runtime"),
    status: AgentSetupRuntimeComponentStatusSchema,
    blocking: z.boolean(),
    provider: AgentSummarySchema.shape.runtimeProvider,
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

const AgentSetupImCliComponentSchema = z
  .object({
    kind: z.literal("im-cli"),
    status: AgentSetupImCliComponentStatusSchema,
    blocking: z.boolean(),
    provider: ImCliProviderSchema,
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * The canonical component projection of one setup snapshot: the exact Computer, the Agent's exact
 * Runtime, then one entry per required IM CLI Provider in canonical order. Schema validation, the
 * Server projection, and in-memory adapters derive rows through the same helper so no consumer
 * guesses at identity, status, or blocking on its own.
 */
export const AgentSetupComponentSchema = z.discriminatedUnion("kind", [
  AgentSetupComputerComponentSchema,
  AgentSetupRuntimeComponentSchema,
  AgentSetupImCliComponentSchema,
]);

export interface AgentSetupComponentProjectionInput {
  computer: AgentSetupComputerState;
  runtime: AgentSetupRuntimeState;
  messaging: AgentSetupMessagingState;
  requiredImCliProviders: readonly ImCliProvider[];
}

function computerComponentStatus(computer: AgentSetupComputerState): AgentSetupComputerComponentStatus {
  if (computer.kind === "bound") return computer.connectionStatus;
  return computer.kind;
}

function runtimeComponentStatus(runtime: AgentSetupRuntimeState): AgentSetupRuntimeComponentStatus {
  if (runtime.kind === "observed") return runtime.status;
  return runtime.kind;
}

/**
 * Projects the canonical component rows for one observed instant. Blocking follows the setup cursor:
 * the Computer leg blocks until it is bound and online, the Runtime leg blocks once the Computer is
 * usable but the exact runtime report is not freshly ready, and each required IM CLI leg blocks only
 * while Messaging is not-configured and the other two legs are ready. A known Messaging state
 * (authorizing, waiting-handoff, blocked, ready) never makes an unselected CLI a continuing blocker.
 */
export function projectAgentSetupComponents(input: AgentSetupComponentProjectionInput): AgentSetupComponent[] {
  const { computer, runtime, messaging } = input;
  const computerReady = computer.kind === "bound" && computer.connectionStatus === "online";
  const runtimeReady = runtime.kind === "observed" && runtime.status === "ready";
  const cliEntries = computer.kind === "bound" ? computer.imCliReadiness : [];
  const cliEntryByProvider = new Map(cliEntries.map((entry) => [entry.provider, entry]));
  const components: AgentSetupComponent[] = [
    {
      kind: "computer",
      status: computerComponentStatus(computer),
      blocking: !computerReady,
      computerId: computer.kind === "not-bound" ? null : computer.computerId,
      displayName: computer.kind === "not-bound" ? null : computer.displayName,
      platform: computer.kind === "not-bound" ? null : computer.platform,
      observedAt: computer.kind === "bound" ? computer.observedAt : null,
    },
    {
      kind: "runtime",
      status: runtimeComponentStatus(runtime),
      blocking: computerReady && !runtimeReady,
      provider: runtime.provider,
      observedAt: runtime.kind === "observed" ? runtime.observedAt : null,
    },
    ...input.requiredImCliProviders.map((provider): AgentSetupComponent => {
      const entry = cliEntryByProvider.get(provider);
      const status = cliReportStatus(entry);
      const ready = status === "ready";
      return {
        kind: "im-cli",
        provider,
        // A missing report — or one without observation evidence — is `waiting`, never a real
        // checking state.
        status,
        observedAt: entry?.observedAt ?? null,
        blocking: messaging.kind === "not-configured" && computerReady && runtimeReady && !ready,
      };
    }),
  ];
  return components;
}

export const AGENT_SETUP_MESSAGING_BLOCKER_CODES = [
  "authorization-failed",
  "reauthorization-required",
  "provider-error",
  "unbind-required",
] as const;
export const AgentSetupMessagingBlockerCodeSchema = z.enum(AGENT_SETUP_MESSAGING_BLOCKER_CODES);

export const AgentSetupMessagingStateSchema = z.union([
  z.object({ kind: z.literal("not-configured") }).strict(),
  z.object({ kind: z.literal("observation-failed") }).strict(),
  z
    .object({
      kind: z.literal("authorizing"),
      provider: z.literal("feishu"),
      attemptId: z.string().uuid(),
      qrUrl: z.string().url().nullable(),
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorizing"),
      provider: z.literal("slack"),
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("waiting-handoff"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
      credentialGeneration: z.number().int().positive(),
      progress: ProviderCliHandoffProgressSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("blocked"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid().optional(),
      credentialGeneration: z.number().int().nonnegative().optional(),
      code: AgentSetupMessagingBlockerCodeSchema,
      errorCode: z.string().min(1).max(120).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
      credentialGeneration: z.number().int().positive(),
    })
    .strict(),
]);

export const AGENT_SETUP_ACTION_KINDS = [
  "refresh",
  "bind-computer",
  "repair-computer",
  "start-messaging",
  "cancel-messaging-attempt",
  "reauthorize-messaging",
  "replace-messaging",
  "unbind-messaging",
] as const;

export const AgentSetupActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("bind-computer") }).strict(),
  z
    .object({
      kind: z.literal("repair-computer"),
      computerId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-messaging"),
      provider: ImProviderSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancel-messaging-attempt"),
      provider: z.literal("feishu"),
      attemptId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reauthorize-messaging"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
      credentialGeneration: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace-messaging"),
      provider: z.literal("feishu"),
      bindingId: z.string().uuid(),
      credentialGeneration: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unbind-messaging"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
    })
    .strict(),
]);

export const AGENT_SETUP_BLOCKER_CODES = [
  "computer-not-bound",
  "computer-rebind-required",
  "computer-offline",
  "runtime-not-ready",
  "provider-cli-not-ready",
  "messaging-not-configured",
  "messaging-not-ready",
  "messaging-unbind-required",
  "resource-observation-failed",
] as const;

export const AgentSetupBlockerSchema = z
  .discriminatedUnion("code", [
    z.object({ code: z.literal("computer-not-bound") }).strict(),
    z.object({ code: z.literal("computer-rebind-required") }).strict(),
    z
      .object({
        code: z.literal("computer-offline"),
        computerId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        code: z.literal("runtime-not-ready"),
        provider: AgentSummarySchema.shape.runtimeProvider,
        status: z.enum(["checking", "install", "sign-in", "unavailable", "waiting"]),
      })
      .strict(),
    z
      .object({
        code: z.literal("provider-cli-not-ready"),
        provider: ImCliProviderSchema,
        status: z.enum(["waiting", "checking", "install", "unavailable"]),
      })
      .strict(),
    z.object({ code: z.literal("messaging-not-configured") }).strict(),
    z
      .object({
        code: z.literal("messaging-not-ready"),
        provider: ImProviderSchema,
        bindingId: z.string().uuid().optional(),
        state: z.enum(["authorizing", "waiting-handoff", "blocked"]),
      })
      .strict(),
    z
      .object({
        code: z.literal("messaging-unbind-required"),
        currentProvider: ImProviderSchema,
        currentBindingId: z.string().uuid(),
        requestedProvider: ImProviderSchema,
      })
      .strict(),
    z
      .object({
        code: z.literal("resource-observation-failed"),
        resource: z.enum(["agent", "computer", "runtime", "messaging"]),
      })
      .strict(),
  ])
  .superRefine((blocker, context) => {
    if (blocker.code === "messaging-unbind-required" && blocker.currentProvider === blocker.requestedProvider) {
      context.addIssue({
        code: "custom",
        path: ["requestedProvider"],
        message: "Unbind is required only when the requested Provider differs from the current Provider",
      });
    }
  });

const AgentSetupSnapshotBaseSchema = z
  .object({
    agent: AgentSummarySchema,
    stage: AgentSetupStageSchema,
    computer: AgentSetupComputerStateSchema,
    runtime: AgentSetupRuntimeStateSchema,
    messaging: AgentSetupMessagingStateSchema,
    /** Canonical required IM CLI Providers in canonical order; the current policy requires both. */
    requiredImCliProviders: z.array(ImCliProviderSchema).max(AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS.length),
    /** Canonical local-preparation components: the exact Computer, Runtime, then each required IM CLI. */
    components: z.array(AgentSetupComponentSchema).max(4),
    blockers: z.array(AgentSetupBlockerSchema).max(16),
    actions: z.array(AgentSetupActionSchema).max(16),
    observedAt: z.string().datetime(),
  })
  .strict();

type AgentSetupSnapshotCandidate = z.infer<typeof AgentSetupSnapshotBaseSchema>;
type AgentSetupIssue = (path: (string | number)[], message: string) => void;

function validateSetupComputer(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  const agentComputer = snapshot.agent.computer;
  if (snapshot.computer.kind === "not-bound") {
    if (agentComputer !== null) addIssue(["computer"], "A not-bound setup Computer must match the Agent");
    if (snapshot.agent.requiresComputerRebind === true) {
      addIssue(["computer"], "A Computer that requires rebind must retain its identity");
    }
    return;
  }

  if (
    agentComputer === null ||
    agentComputer.computerId !== snapshot.computer.computerId ||
    agentComputer.displayName !== snapshot.computer.displayName ||
    agentComputer.platform !== snapshot.computer.platform
  ) {
    addIssue(["computer"], "The setup Computer must match the exact Agent binding");
  }
  if (snapshot.computer.kind === "observation-failed") return;
  if (snapshot.computer.kind === "requires-rebind" && snapshot.agent.requiresComputerRebind !== true) {
    addIssue(["computer"], "A requires-rebind setup Computer must be marked on the Agent");
  }
  if (snapshot.computer.kind === "bound" && snapshot.agent.requiresComputerRebind === true) {
    addIssue(["computer"], "A Computer that requires rebind is not a usable bound Computer");
  }
}

function expectedRuntimeUnavailableReason(
  computer: AgentSetupSnapshotCandidate["computer"],
): AgentSetupRuntimeUnavailableReason | undefined {
  if (computer.kind === "not-bound") return "computer-not-bound";
  if (computer.kind === "observation-failed") return "computer-observation-failed";
  if (computer.kind === "requires-rebind") return "computer-rebind-required";
  if (computer.connectionStatus === "offline") return "computer-offline";
  return undefined;
}

function validateSetupRuntime(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  if (snapshot.runtime.provider !== snapshot.agent.runtimeProvider) {
    addIssue(["runtime", "provider"], "Runtime readiness must describe the Agent's exact Provider");
  }
  const unavailableReason = expectedRuntimeUnavailableReason(snapshot.computer);
  if (unavailableReason === undefined) {
    if (
      snapshot.runtime.kind !== "observed" &&
      snapshot.runtime.kind !== "waiting" &&
      snapshot.runtime.kind !== "observation-failed"
    ) {
      addIssue(
        ["runtime"],
        "An online bound Computer must expose an observed, waiting, or observation-failed runtime readiness",
      );
    }
    return;
  }
  if (snapshot.runtime.kind !== "unavailable" || snapshot.runtime.reason !== unavailableReason) {
    addIssue(["runtime"], "Runtime state must preserve why the exact Computer cannot be observed");
  }
}

function setupCliReadiness(snapshot: AgentSetupSnapshotCandidate): ComputerImCliReadinessCollection {
  return snapshot.computer.kind === "bound" ? snapshot.computer.imCliReadiness : [];
}

/**
 * The effective IM CLI status one Computer report row carries. Only an `unavailable` row — the
 * offline connection fence — is legitimate without an observation time: a ready/checking/install
 * report with no `observedAt` is evidence-less and must read as waiting, never as a real
 * observation. Freshness itself stays source-authoritative.
 */
function cliReportStatus(
  entry: ComputerImCliReadiness | undefined,
): "waiting" | "checking" | "install" | "ready" | "unavailable" {
  if (!entry) return "waiting";
  if (entry.observedAt === null && entry.status !== "unavailable") return "waiting";
  return entry.status;
}

/** Serializes JSON-shaped data with object keys sorted, so parsed and authored objects compare equal. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredCliReady(snapshot: AgentSetupSnapshotCandidate, provider: "feishu" | "slack"): boolean {
  const entry = setupCliReadiness(snapshot).find((readiness) => readiness.provider === provider);
  return cliReportStatus(entry) === "ready";
}

/** The Provider CLI blockers canonical for the given facts: one per required CLI that is not ready. */
function failingProviderCliBlockers(snapshot: AgentSetupSnapshotCandidate): AgentSetupBlocker[] {
  return snapshot.requiredImCliProviders.flatMap((provider) => {
    const entry = setupCliReadiness(snapshot).find((readiness) => readiness.provider === provider);
    const status = cliReportStatus(entry);
    return status === "ready" ? [] : [{ code: "provider-cli-not-ready", provider, status }];
  });
}

function deriveSetupStage(snapshot: AgentSetupSnapshotCandidate): AgentSetupStage {
  const computerReady = snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "online";
  if (!computerReady) return "needs-computer";
  const runtimeReady = snapshot.runtime.kind === "observed" && snapshot.runtime.status === "ready";
  if (!runtimeReady) return "needs-runtime";
  if (snapshot.messaging.kind === "ready") return "ready";
  // The dual-Provider local preparation gate applies only while Messaging is not-configured; any
  // known Messaging state (authorizing, waiting-handoff, blocked, observation-failed) advances or
  // fails closed without consulting the unselected CLI reports again.
  if (snapshot.messaging.kind !== "not-configured") return "needs-messaging";
  return snapshot.requiredImCliProviders.every((provider) => requiredCliReady(snapshot, provider))
    ? "needs-messaging"
    : "needs-provider-clis";
}

function hasObservationBlocker(snapshot: AgentSetupSnapshotCandidate, resource: "computer" | "runtime" | "messaging") {
  return snapshot.blockers.some(
    (blocker) => blocker.code === "resource-observation-failed" && blocker.resource === resource,
  );
}

function validateSetupStage(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  if (snapshot.stage !== deriveSetupStage(snapshot)) {
    addIssue(["stage"], "Stage must be derived from Computer, runtime, and Messaging facts in canonical order");
  }

  const blockerCodes = new Set(snapshot.blockers.map((blocker) => blocker.code));
  if (snapshot.stage === "ready" && snapshot.blockers.length > 0) {
    addIssue(["blockers"], "A ready Agent setup cannot retain blockers");
    return;
  }
  const providerCliBlockers = snapshot.blockers.filter((blocker) => blocker.code === "provider-cli-not-ready");
  if (snapshot.stage === "needs-provider-clis") {
    const expected = failingProviderCliBlockers(snapshot);
    if (stableSerialize(providerCliBlockers) !== stableSerialize(expected)) {
      addIssue(
        ["blockers"],
        "A needs-provider-clis setup must block exactly the required IM CLIs that are not freshly ready",
      );
    }
    return;
  }
  if (providerCliBlockers.length > 0) {
    addIssue(["blockers"], "Provider CLI blockers apply only while the setup waits on required IM CLI readiness");
  }
  if (
    snapshot.stage === "needs-runtime" &&
    !blockerCodes.has("runtime-not-ready") &&
    !hasObservationBlocker(snapshot, "runtime")
  ) {
    addIssue(["blockers"], "A needs-runtime setup must name its runtime blocker");
  }
  const hasMessagingBlocker = blockerCodes.has("messaging-not-configured") || blockerCodes.has("messaging-not-ready");
  if (snapshot.stage === "needs-messaging" && !hasMessagingBlocker && !hasObservationBlocker(snapshot, "messaging")) {
    addIssue(["blockers"], "A needs-messaging setup must name its Messaging blocker");
  }
  const hasComputerBlocker =
    blockerCodes.has("computer-not-bound") ||
    blockerCodes.has("computer-rebind-required") ||
    blockerCodes.has("computer-offline");
  if (snapshot.stage === "needs-computer" && !hasComputerBlocker && !hasObservationBlocker(snapshot, "computer")) {
    addIssue(["blockers"], "A needs-computer setup must name its Computer blocker");
  }
}

function readCurrentBinding(
  messaging: AgentSetupSnapshotCandidate["messaging"],
): { provider: "feishu" | "slack"; bindingId: string; credentialGeneration: number } | undefined {
  if (messaging.kind === "waiting-handoff" || messaging.kind === "ready") {
    return {
      provider: messaging.provider,
      bindingId: messaging.bindingId,
      credentialGeneration: messaging.credentialGeneration,
    };
  }
  if (messaging.kind === "blocked" && messaging.bindingId && messaging.credentialGeneration !== undefined) {
    return {
      provider: messaging.provider,
      bindingId: messaging.bindingId,
      credentialGeneration: messaging.credentialGeneration,
    };
  }
  return undefined;
}

function validateSetupAction(
  snapshot: AgentSetupSnapshotCandidate,
  action: AgentSetupSnapshotCandidate["actions"][number],
  index: number,
  addIssue: AgentSetupIssue,
): void {
  if (action.kind === "start-messaging" && snapshot.messaging.kind !== "not-configured") {
    addIssue(["actions", index], "A Provider can be started only after canonical state is not-configured");
  }
  if (
    action.kind === "start-messaging" &&
    (snapshot.stage !== "needs-messaging" || failingProviderCliBlockers(snapshot).length > 0)
  ) {
    addIssue(
      ["actions", index],
      "A Provider can be started only after the required IM CLI preparation gate has passed",
    );
  }
  if (action.kind === "cancel-messaging-attempt") {
    const isCurrentFeishuAttempt =
      snapshot.messaging.kind === "authorizing" &&
      snapshot.messaging.provider === "feishu" &&
      snapshot.messaging.attemptId === action.attemptId;
    if (!isCurrentFeishuAttempt) addIssue(["actions", index], "Cancel must name the current Feishu setup attempt");
  }
  if (
    action.kind !== "reauthorize-messaging" &&
    action.kind !== "replace-messaging" &&
    action.kind !== "unbind-messaging"
  ) {
    return;
  }
  const currentBinding = readCurrentBinding(snapshot.messaging);
  if (currentBinding?.provider !== action.provider || currentBinding.bindingId !== action.bindingId) {
    addIssue(["actions", index], "Binding actions must name the current Provider and binding identity");
  }
  if (action.kind !== "unbind-messaging" && currentBinding?.credentialGeneration !== action.credentialGeneration) {
    addIssue(["actions", index], "Binding authorization actions must name the current credential generation");
  }
}

function validateSetupActions(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  const actionKeys = new Set<string>();
  for (const [index, action] of snapshot.actions.entries()) {
    const actionKey = JSON.stringify(action);
    if (actionKeys.has(actionKey)) addIssue(["actions", index], "Permitted actions must be unique");
    actionKeys.add(actionKey);
    validateSetupAction(snapshot, action, index, addIssue);
  }
}

function validateSetupBlockers(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  const currentBinding = readCurrentBinding(snapshot.messaging);
  for (const [index, blocker] of snapshot.blockers.entries()) {
    if (blocker.code !== "messaging-unbind-required") continue;
    if (currentBinding?.provider !== blocker.currentProvider || currentBinding.bindingId !== blocker.currentBindingId) {
      addIssue(["blockers", index], "An unbind-required blocker must name the current binding");
    }
  }
}

function validateSetupRequiredProviders(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  const { requiredImCliProviders } = snapshot;
  const canonical = AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS;
  if (
    requiredImCliProviders.length !== canonical.length ||
    requiredImCliProviders.some((provider, index) => provider !== canonical[index])
  ) {
    addIssue(
      ["requiredImCliProviders"],
      "Required IM CLI Providers must be exactly the canonical set in canonical order, without duplicates",
    );
  }
}

function validateSetupComponents(snapshot: AgentSetupSnapshotCandidate, addIssue: AgentSetupIssue): void {
  const expected = projectAgentSetupComponents({
    computer: snapshot.computer,
    runtime: snapshot.runtime,
    messaging: snapshot.messaging,
    requiredImCliProviders: snapshot.requiredImCliProviders,
  });
  if (stableSerialize(snapshot.components) !== stableSerialize(expected)) {
    addIssue(
      ["components"],
      "Components must project the exact Computer, runtime Provider, and required IM CLI readiness in canonical order",
    );
  }
}

export const AgentSetupSnapshotSchema = AgentSetupSnapshotBaseSchema.superRefine((snapshot, context) => {
  const addIssue: AgentSetupIssue = (path, message) => context.addIssue({ code: "custom", path, message });
  validateSetupComputer(snapshot, addIssue);
  validateSetupRuntime(snapshot, addIssue);
  validateSetupRequiredProviders(snapshot, addIssue);
  validateSetupComponents(snapshot, addIssue);
  validateSetupStage(snapshot, addIssue);
  validateSetupActions(snapshot, addIssue);
  validateSetupBlockers(snapshot, addIssue);
});

export const AGENT_SETUP_RETURN_SURFACES = ["agent-setup", "agent-messaging-settings"] as const;
export const AgentSetupReturnSurfaceSchema = z.enum(AGENT_SETUP_RETURN_SURFACES);

export const AgentSetupExpectedMessagingStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unbound") }).strict(),
  z
    .object({
      kind: z.literal("bound"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
      credentialGeneration: z.number().int().positive(),
    })
    .strict(),
]);

export const AgentSetupSlackOAuthContextSchema = z
  .object({
    agentId: z.string().uuid(),
    intent: SlackConfigurationIntentSchema,
    returnSurface: AgentSetupReturnSurfaceSchema,
    expectedMessaging: AgentSetupExpectedMessagingStateSchema,
  })
  .strict()
  .superRefine((oauth, context) => {
    if (oauth.intent === "create" && oauth.expectedMessaging.kind !== "unbound") {
      context.addIssue({
        code: "custom",
        path: ["expectedMessaging"],
        message: "Slack create requires the Agent to remain unbound",
      });
    }
    if (
      oauth.intent === "reauthorize" &&
      (oauth.expectedMessaging.kind !== "bound" || oauth.expectedMessaging.provider !== "slack")
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedMessaging"],
        message: "Slack reauthorization requires the exact current Slack binding",
      });
    }
  });

export const AGENT_CREATION_RECOVERY_ACTIONS = ["check-result", "retry", "discard"] as const;
export const AgentCreationRecoveryActionSchema = z.enum(AGENT_CREATION_RECOVERY_ACTIONS);

export type AgentSetupStage = z.infer<typeof AgentSetupStageSchema>;
export type AgentSetupComputerState = z.infer<typeof AgentSetupComputerStateSchema>;
export type AgentSetupRuntimeUnavailableReason = z.infer<typeof AgentSetupRuntimeUnavailableReasonSchema>;
export type AgentSetupRuntimeState = z.infer<typeof AgentSetupRuntimeStateSchema>;
export type AgentSetupComputerComponentStatus = z.infer<typeof AgentSetupComputerComponentStatusSchema>;
export type AgentSetupRuntimeComponentStatus = z.infer<typeof AgentSetupRuntimeComponentStatusSchema>;
export type AgentSetupImCliComponentStatus = z.infer<typeof AgentSetupImCliComponentStatusSchema>;
export type AgentSetupComputerComponent = z.infer<typeof AgentSetupComputerComponentSchema>;
export type AgentSetupRuntimeComponent = z.infer<typeof AgentSetupRuntimeComponentSchema>;
export type AgentSetupImCliComponent = z.infer<typeof AgentSetupImCliComponentSchema>;
export type AgentSetupComponent = z.infer<typeof AgentSetupComponentSchema>;
export type AgentSetupMessagingBlockerCode = z.infer<typeof AgentSetupMessagingBlockerCodeSchema>;
export type AgentSetupMessagingState = z.infer<typeof AgentSetupMessagingStateSchema>;
export type AgentSetupAction = z.infer<typeof AgentSetupActionSchema>;
export type AgentSetupBlocker = z.infer<typeof AgentSetupBlockerSchema>;
export type AgentSetupSnapshot = z.infer<typeof AgentSetupSnapshotSchema>;
export type AgentSetupReturnSurface = z.infer<typeof AgentSetupReturnSurfaceSchema>;
export type AgentSetupExpectedMessagingState = z.infer<typeof AgentSetupExpectedMessagingStateSchema>;
export type AgentSetupSlackOAuthContext = z.infer<typeof AgentSetupSlackOAuthContextSchema>;
export type AgentCreationRecoveryAction = z.infer<typeof AgentCreationRecoveryActionSchema>;
