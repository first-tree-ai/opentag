import { z } from "zod";
import { AgentSummarySchema } from "./agent.js";
import { ComputerConnectionStatusSchema, ComputerPlatformSchema, ProviderReadinessStatusSchema } from "./computer.js";
import { ImProviderSchema, ProviderCliHandoffProgressSchema, SlackConfigurationIntentSchema } from "./im-binding.js";

export const AGENT_SETUP_STAGES = ["needs-computer", "needs-runtime", "needs-messaging", "ready"] as const;
export const AgentSetupStageSchema = z.enum(AGENT_SETUP_STAGES);

const AgentSetupComputerIdentityShape = {
  computerId: z.string().uuid(),
  displayName: z.string().min(1),
  platform: ComputerPlatformSchema,
};

export const AgentSetupComputerStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-bound") }).strict(),
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
      lastSeenAt: z.string().datetime().nullable(),
      observedAt: z.string().datetime(),
    })
    .strict(),
]);

export const AgentSetupRuntimeUnavailableReasonSchema = z.enum([
  "computer-not-bound",
  "computer-rebind-required",
  "computer-offline",
]);

export const AgentSetupRuntimeStateSchema = z.discriminatedUnion("kind", [
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
      observedAt: z.string().datetime().nullable(),
    })
    .strict(),
]);

export const AGENT_SETUP_MESSAGING_BLOCKER_CODES = [
  "authorization-failed",
  "reauthorization-required",
  "provider-error",
  "unbind-required",
] as const;
export const AgentSetupMessagingBlockerCodeSchema = z.enum(AGENT_SETUP_MESSAGING_BLOCKER_CODES);

export const AgentSetupMessagingStateSchema = z.union([
  z.object({ kind: z.literal("not-configured") }).strict(),
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
      progress: ProviderCliHandoffProgressSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("blocked"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid().optional(),
      code: AgentSetupMessagingBlockerCodeSchema,
      errorCode: z.string().min(1).max(120).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      provider: ImProviderSchema,
      bindingId: z.string().uuid(),
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
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace-messaging"),
      provider: z.literal("feishu"),
      bindingId: z.string().uuid(),
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
        status: z.enum(["checking", "install", "sign-in", "unavailable"]),
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
    if (snapshot.runtime.kind !== "observed") {
      addIssue(["runtime"], "An online bound Computer must expose its observed runtime readiness");
    }
    return;
  }
  if (snapshot.runtime.kind !== "unavailable" || snapshot.runtime.reason !== unavailableReason) {
    addIssue(["runtime"], "Runtime state must preserve why the exact Computer cannot be observed");
  }
}

function deriveSetupStage(snapshot: AgentSetupSnapshotCandidate): AgentSetupStage {
  const computerReady = snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "online";
  if (!computerReady) return "needs-computer";
  const runtimeReady = snapshot.runtime.kind === "observed" && snapshot.runtime.status === "ready";
  if (!runtimeReady) return "needs-runtime";
  return snapshot.messaging.kind === "ready" ? "ready" : "needs-messaging";
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
  if (snapshot.stage === "needs-runtime" && !blockerCodes.has("runtime-not-ready")) {
    addIssue(["blockers"], "A needs-runtime setup must name its runtime blocker");
  }
  const hasMessagingBlocker = blockerCodes.has("messaging-not-configured") || blockerCodes.has("messaging-not-ready");
  if (snapshot.stage === "needs-messaging" && !hasMessagingBlocker) {
    addIssue(["blockers"], "A needs-messaging setup must name its Messaging blocker");
  }
  const hasComputerBlocker =
    blockerCodes.has("computer-not-bound") ||
    blockerCodes.has("computer-rebind-required") ||
    blockerCodes.has("computer-offline");
  if (snapshot.stage === "needs-computer" && !hasComputerBlocker) {
    addIssue(["blockers"], "A needs-computer setup must name its Computer blocker");
  }
}

function readCurrentBinding(
  messaging: AgentSetupSnapshotCandidate["messaging"],
): { provider: "feishu" | "slack"; bindingId: string } | undefined {
  if (messaging.kind === "waiting-handoff" || messaging.kind === "ready") {
    return { provider: messaging.provider, bindingId: messaging.bindingId };
  }
  if (messaging.kind === "blocked" && messaging.bindingId) {
    return { provider: messaging.provider, bindingId: messaging.bindingId };
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

export const AgentSetupSnapshotSchema = AgentSetupSnapshotBaseSchema.superRefine((snapshot, context) => {
  const addIssue: AgentSetupIssue = (path, message) => context.addIssue({ code: "custom", path, message });
  validateSetupComputer(snapshot, addIssue);
  validateSetupRuntime(snapshot, addIssue);
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
export type AgentSetupMessagingBlockerCode = z.infer<typeof AgentSetupMessagingBlockerCodeSchema>;
export type AgentSetupMessagingState = z.infer<typeof AgentSetupMessagingStateSchema>;
export type AgentSetupAction = z.infer<typeof AgentSetupActionSchema>;
export type AgentSetupBlocker = z.infer<typeof AgentSetupBlockerSchema>;
export type AgentSetupSnapshot = z.infer<typeof AgentSetupSnapshotSchema>;
export type AgentSetupReturnSurface = z.infer<typeof AgentSetupReturnSurfaceSchema>;
export type AgentSetupExpectedMessagingState = z.infer<typeof AgentSetupExpectedMessagingStateSchema>;
export type AgentSetupSlackOAuthContext = z.infer<typeof AgentSetupSlackOAuthContextSchema>;
export type AgentCreationRecoveryAction = z.infer<typeof AgentCreationRecoveryActionSchema>;
