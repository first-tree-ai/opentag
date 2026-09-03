import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";
import { parseSemVer } from "./semver.js";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);
export const ProviderReadinessStatusSchema = z.enum(["checking", "install", "sign-in", "ready", "unavailable"]);
export const ImCliReadinessStatusSchema = z.enum(["checking", "install", "ready", "unavailable"]);
export const IM_CLI_PROVIDERS = ["feishu", "slack"] as const;
export const ImCliProviderSchema = z.enum(IM_CLI_PROVIDERS);
export const INTEGRATION_CREDENTIAL_EXECUTION_STATUSES = [
  "unconfirmed",
  "checking",
  "retrying",
  "ready",
  "needs_attention",
] as const;
export const IntegrationCredentialExecutionStatusSchema = z.enum(INTEGRATION_CREDENTIAL_EXECUTION_STATUSES);
export const INTEGRATION_CREDENTIAL_EXECUTION_REASONS = [
  "provider_unreachable",
  "rate_limited",
  "credential_rejected",
  "identity_mismatch",
  "scope_missing",
  "upgrade_required",
] as const;
export const IntegrationCredentialExecutionReasonSchema = z.enum(INTEGRATION_CREDENTIAL_EXECUTION_REASONS);
export const PROVIDER_CLI_VALIDATION_RETRY_REASONS = [
  "validation_busy",
  "validation_expired",
  "artifact_changed",
] as const;
export const ProviderCliValidationRetryReasonSchema = z.enum(PROVIDER_CLI_VALIDATION_RETRY_REASONS);
export const ProviderCliValidationResultReasonSchema = z.enum([
  ...INTEGRATION_CREDENTIAL_EXECUTION_REASONS,
  ...PROVIDER_CLI_VALIDATION_RETRY_REASONS,
]);
export const PROVIDER_READINESS_V1_HEADER = "x-opentag-provider-readiness";

export const ComputerConnectCodeModeSchema = z.enum(["create", "repair"]);

/**
 * Exchange identifies the local installation, not an existing Computer. The Server decides create vs
 * repair only from the one-time code: create always allocates a new Computer, and repair names its
 * target Computer when the code is issued.
 */
export const ComputerConnectCodeExchangeRequestSchema = z
  .object({
    code: z.string().trim().min(16).max(512),
    installationId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export const ComputerConnectCodeExchangeResponseSchema = z
  .object({
    /** Present when this setup code atomically bound an explicit Agent to the connected Computer. */
    agentId: z.string().uuid().optional(),
    /**
     * The exact Runtime of the bound Agent, answered only to Clients that marked themselves with
     * {@link clientSupportsComputerRuntimeProvider} support. Unmarked Clients keep the strict legacy
     * response shape, and `agentId`-only responses stay parseable for a marked Client talking to an
     * older Server.
     */
    runtimeProvider: AgentRuntimeProviderSchema.optional(),
    computerId: z.string().uuid(),
    installationId: z.string().uuid(),
    machineToken: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.runtimeProvider !== undefined && response.agentId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["runtimeProvider"],
        message: "runtimeProvider is only meaningful next to the bound agentId it describes",
      });
    }
  });

/**
 * The SemVer build-metadata identifier a Client appends to its own version to advertise that it
 * understands the targeted connect exchange `runtimeProvider` field. It never changes precedence
 * (SemVer build metadata is ignored by `compareSemVer`) and it never raises the release floor: the
 * Server answers the field only to Clients that carry this exact marker, so an unmarked legacy
 * Client keeps receiving the response shape its own strict parser knows.
 */
export const COMPUTER_RUNTIME_PROVIDER_CAPABILITY = "opentag-connect-runtime-v1";

const COMPUTER_CLIENT_VERSION_MAX_LENGTH = 64;

/**
 * Marks a Client version as supporting the targeted connect exchange `runtimeProvider` by appending
 * {@link COMPUTER_RUNTIME_PROVIDER_CAPABILITY} as SemVer build metadata. Existing prerelease and
 * build identifiers are preserved; applying the marker twice is a no-op. Invalid SemVer input and
 * any version whose marked result would exceed the 64-character Client version bound are rejected
 * before a caller could send them over the wire.
 */
export function withComputerRuntimeProviderSupport(version: string): string {
  const parsed = parseSemVer(version);
  if (!parsed) {
    throw new TypeError(`Cannot mark an invalid SemVer Client version: ${JSON.stringify(version)}`);
  }
  const result = parsed.build.includes(COMPUTER_RUNTIME_PROVIDER_CAPABILITY)
    ? version
    : `${version}${parsed.build.length > 0 ? "." : "+"}${COMPUTER_RUNTIME_PROVIDER_CAPABILITY}`;
  if (result.length > COMPUTER_CLIENT_VERSION_MAX_LENGTH) {
    throw new TypeError(
      `Marked Client version exceeds ${COMPUTER_CLIENT_VERSION_MAX_LENGTH} characters: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

/**
 * Fail-closed recognizer for the {@link COMPUTER_RUNTIME_PROVIDER_CAPABILITY} marker: true only for a
 * strict, at-most-64-character SemVer version whose build metadata carries the exact capability
 * identifier. Invalid or overlong versions, unmarked versions, and unknown or lookalike markers
 * (wrong casing, wrong suffix, the marker smuggled into prerelease position) all answer false.
 */
export function clientSupportsComputerRuntimeProvider(version: string): boolean {
  if (version.length > COMPUTER_CLIENT_VERSION_MAX_LENGTH) return false;
  const parsed = parseSemVer(version);
  return parsed?.build.includes(COMPUTER_RUNTIME_PROVIDER_CAPABILITY) ?? false;
}

/** Empty body and `{ mode: "create" }` both issue a create code. */
export const AccountComputerConnectCodeCreateRequestSchema = z
  .object({
    mode: z.literal("create").optional(),
    /** Optional setup target. The Server embeds it into the opaque code and binds it at redemption. */
    targetAgentId: z.string().uuid().optional(),
  })
  .strict();

/** Repair is Account-authorized and must name an explicit Computer owned by that Account. */
export const AccountComputerConnectCodeRepairRequestSchema = z
  .object({
    mode: z.literal("repair"),
    targetComputerId: z.string().uuid(),
    /** When supplied, the Agent must already be bound to the repaired Computer. */
    targetAgentId: z.string().uuid().optional(),
  })
  .strict();

/**
 * The Account-native connect-code request carries no client-selected authority: the issuing Account comes
 * from the access token alone. Repair names its target Computer; create never infers one.
 */
export const AccountComputerConnectCodeIssueRequestSchema = z.union([
  AccountComputerConnectCodeCreateRequestSchema,
  AccountComputerConnectCodeRepairRequestSchema,
]);

export const ComputerConnectCodeIssueResponseSchema = z
  .object({
    /**
     * The Server's own handle on the issued code row. Opaque and non-secret: it names the code for the
     * pollable status read and is worthless at the exchange, which still requires the code itself.
     */
    connectCodeId: z.string().uuid(),
    bootstrapCommand: z.string().min(1),
    expiresIn: z.number().int().positive(),
    issuedAt: z.string().datetime(),
    mode: ComputerConnectCodeModeSchema.optional(),
  })
  .strict();

/**
 * The lifecycle of one issued connect code as the issuing Account may observe it. `pending` means
 * nobody has redeemed it yet; `redeemed` names the exact Computer that did. `expired` and `revoked`
 * fail closed: the read keeps answering, but it never names a Computer for them.
 */
export const ComputerConnectCodeStateSchema = z.enum(["pending", "redeemed", "expired", "revoked"]);

/**
 * The Server-authoritative correlation between a connect code and the Computer that redeemed it.
 * Carries identity and timing evidence only — never the raw code, its hash, or any machine token.
 * `computerId` and `redeemedAt` are present exactly in the `redeemed` state.
 */
const ComputerConnectCodeTerminalStatusFields = {
  connectCodeId: z.string().uuid(),
  computerId: z.null(),
  redeemedAt: z.null(),
};

export const ComputerConnectCodeStatusSchema = z.discriminatedUnion("state", [
  z.object({ ...ComputerConnectCodeTerminalStatusFields, state: z.literal("pending") }).strict(),
  z.object({ ...ComputerConnectCodeTerminalStatusFields, state: z.literal("expired") }).strict(),
  z.object({ ...ComputerConnectCodeTerminalStatusFields, state: z.literal("revoked") }).strict(),
  z
    .object({
      connectCodeId: z.string().uuid(),
      state: z.literal("redeemed"),
      computerId: z.string().uuid(),
      redeemedAt: z.string().datetime(),
    })
    .strict(),
]);

export const ComputerProviderReadinessSchema = z
  .object({
    provider: AgentRuntimeProviderSchema,
    status: ProviderReadinessStatusSchema,
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

export const ComputerProviderReadinessCollectionSchema = z
  .array(ComputerProviderReadinessSchema)
  .max(AGENT_RUNTIME_PROVIDERS.length)
  .superRefine((observations, context) => {
    const seen = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      if (seen.has(observation.provider)) {
        context.addIssue({ code: "custom", path: [index, "provider"], message: "Provider readiness must be unique" });
      }
      seen.add(observation.provider);
      if (
        index > 0 &&
        AGENT_RUNTIME_PROVIDERS.indexOf(observation.provider) <
          AGENT_RUNTIME_PROVIDERS.indexOf(observations[index - 1]?.provider ?? "codex")
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "provider"],
          message: "Provider readiness must use canonical Provider order",
        });
      }
    }
  });

export const ComputerImCliReadinessSchema = z
  .object({
    provider: ImCliProviderSchema,
    status: ImCliReadinessStatusSchema,
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

export const ComputerImCliReadinessCollectionSchema = z
  .array(ComputerImCliReadinessSchema)
  .max(IM_CLI_PROVIDERS.length)
  .superRefine((observations, context) => {
    const seen = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      if (seen.has(observation.provider)) {
        context.addIssue({ code: "custom", path: [index, "provider"], message: "IM CLI readiness must be unique" });
      }
      seen.add(observation.provider);
      if (
        index > 0 &&
        IM_CLI_PROVIDERS.indexOf(observation.provider) <
          IM_CLI_PROVIDERS.indexOf(observations[index - 1]?.provider ?? "feishu")
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "provider"],
          message: "IM CLI readiness must use canonical Provider order",
        });
      }
    }
  });

/**
 * Local computer preparation vocabulary. A single `connect`/`repair` run reports one Result whose
 * Components mirror the plan the run executed: the Computer itself, the targeted Runtime CLI
 * (`runtime:codex`, `runtime:claude-code`, or `runtime:unconfirmed` when the Server did not name
 * one), and the Provider CLIs (`im-cli:lark`, `im-cli:slack`). Components may carry child Checks
 * (for example the Computer's credential and daemon) with bounded ids of their own.
 *
 * This is local proof rendered from one run only: it is never persisted and never becomes a Server
 * stage. The Server has no counterpart state machine, so the schema enforces internal consistency
 * rather than deriving verdicts: duplicate top-level component ids, counts that do not match the
 * reported components, and `ready` claims that conceal a required or blocking non-ready child Check
 * are all invalid. A non-blocking warning (`blocking: false` only) never overrides `ready`.
 */
export const LocalPreparationStatusSchema = z.enum([
  "waiting",
  "checking",
  "install_required",
  "installing",
  "ready",
  "needs_attention",
  "unavailable",
  "stale",
  "skipped",
]);

export const LocalPreparationActionSchema = z
  .object({
    /** Shell command the user may run to repair or verify. */
    command: z.string().trim().min(1).max(16384).optional(),
    /** Human-readable step the user should take when no single command captures it. */
    instruction: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine((action) => action.command !== undefined || action.instruction !== undefined, {
    message: "A local preparation action must provide a command or an instruction",
  });

export const LocalPreparationWarningSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(512).optional(),
    /** Warnings never block: `blocking` is fixed false so no warning can override a ready verdict. */
    blocking: z.literal(false),
  })
  .strict();

const LocalPreparationCheckFieldsSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    /** A required Check must reach `ready` before its Component may claim readiness. */
    required: z.boolean(),
    status: LocalPreparationStatusSchema,
    /** Currently blocking, not merely a gate: a ready Check must be unblocked. */
    blocking: z.boolean(),
    phase: z.string().trim().min(1).max(64).optional(),
    message: z.string().trim().min(1).max(512).optional(),
    version: z.string().trim().min(1).max(64).optional(),
    observedAt: z.string().datetime().optional(),
    diagnosticCode: z.string().trim().min(1).max(64).optional(),
    nextAction: LocalPreparationActionSchema.optional(),
    verifyAction: LocalPreparationActionSchema.optional(),
    warnings: z.array(LocalPreparationWarningSchema).optional(),
  })
  .strict();

export const LocalPreparationCheckSchema = LocalPreparationCheckFieldsSchema.refine(
  (check) => check.status !== "ready" || !check.blocking,
  { path: ["blocking"], message: "A ready Check cannot be blocking" },
);

export const LocalPreparationComponentSchema = LocalPreparationCheckFieldsSchema.extend({
  /** Child Checks (for example credential and daemon under the Computer component). */
  checks: z.array(LocalPreparationCheckSchema).optional(),
})
  .strict()
  .refine((component) => component.status !== "ready" || !component.blocking, {
    path: ["blocking"],
    message: "A ready Component cannot be blocking",
  });

const LocalComputerPreparationResultFieldsSchema = z
  .object({
    /** Human projection of `localReady`: `ready` exactly when every required Component is. */
    status: z.enum(["ready", "needs_attention"]),
    components: z.array(LocalPreparationComponentSchema).min(1),
    readyCount: z.number().int().nonnegative(),
    requiredCount: z.number().int().nonnegative(),
    localReady: z.boolean(),
  })
  .strict();

export const LocalComputerPreparationResultSchema = LocalComputerPreparationResultFieldsSchema.superRefine(
  (result, context) => {
    for (const issue of assessLocalPreparation(result)) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  },
);

interface LocalPreparationIssue {
  path: (number | string)[];
  message: string;
}

type LocalPreparationResultInput = z.infer<typeof LocalComputerPreparationResultFieldsSchema>;

/**
 * The gate Checks of one Component: children that are required or blocking and have not reached
 * `ready` (including deliberate `skipped` states such as a `--no-start` daemon). A Component that
 * reports `ready` while any of them is non-ready would conceal a repair need.
 */
function concealedGateCheckIds(component: LocalPreparationComponent): string[] {
  return (component.checks ?? []).flatMap((check) =>
    check.blocking || (check.required && check.status !== "ready") ? [check.id] : [],
  );
}

function readyComponentIssue(
  component: LocalPreparationComponent,
  concealed: string[],
  index: number,
): LocalPreparationIssue | undefined {
  if (component.status !== "ready" || concealed.length === 0) return undefined;
  return {
    path: ["components", index, "status"],
    message: `A ready Component cannot conceal non-ready required/blocking Checks: ${concealed.join(", ")}`,
  };
}

function assessLocalPreparation(result: LocalPreparationResultInput): LocalPreparationIssue[] {
  const issues: LocalPreparationIssue[] = [];
  const seen = new Set<string>();
  const summaries = result.components.map((component, index) => ({
    component,
    index,
    concealed: concealedGateCheckIds(component),
  }));
  for (const summary of summaries) {
    const { component, concealed, index } = summary;
    if (seen.has(component.id)) {
      issues.push({ path: ["components", index, "id"], message: "Component ids must be unique" });
    }
    seen.add(component.id);
    const readyIssue = readyComponentIssue(component, concealed, index);
    if (readyIssue) issues.push(readyIssue);
  }
  const ready = (summary: (typeof summaries)[number]) =>
    summary.component.status === "ready" && !summary.component.blocking && summary.concealed.length === 0;
  const requiredCount = summaries.filter((summary) => summary.component.required).length;
  const readyCount = summaries.filter((summary) => summary.component.required && ready(summary)).length;
  const allRequiredReady = requiredCount === readyCount;
  if (requiredCount !== result.requiredCount) {
    issues.push({
      path: ["requiredCount"],
      message: `requiredCount must match the ${requiredCount} required Component(s)`,
    });
  }
  if (readyCount !== result.readyCount) {
    issues.push({
      path: ["readyCount"],
      message: `readyCount must match the ${readyCount} ready Component(s)`,
    });
  }
  if (result.localReady !== allRequiredReady) {
    issues.push({
      path: ["localReady"],
      message: allRequiredReady
        ? "localReady must be true when every required Component is ready and unblocked"
        : "localReady must be false while a required Component is not ready or unblocked",
    });
  }
  const expectedStatus = allRequiredReady ? "ready" : "needs_attention";
  if (result.status !== expectedStatus) {
    issues.push({
      path: ["status"],
      message: `status must be ${expectedStatus} for the reported required Components`,
    });
  }
  return issues;
}

export type LocalPreparationStatus = z.infer<typeof LocalPreparationStatusSchema>;
export type LocalPreparationAction = z.infer<typeof LocalPreparationActionSchema>;
export type LocalPreparationWarning = z.infer<typeof LocalPreparationWarningSchema>;
export type LocalPreparationCheck = z.infer<typeof LocalPreparationCheckSchema>;
export type LocalPreparationComponent = z.infer<typeof LocalPreparationComponentSchema>;
export type LocalComputerPreparationResult = z.infer<typeof LocalComputerPreparationResultSchema>;
export type ComputerPlatform = z.infer<typeof ComputerPlatformSchema>;
export type ComputerConnectCodeMode = z.infer<typeof ComputerConnectCodeModeSchema>;
export type ComputerConnectCodeExchangeRequest = z.infer<typeof ComputerConnectCodeExchangeRequestSchema>;
export type ComputerConnectCodeExchangeResponse = z.infer<typeof ComputerConnectCodeExchangeResponseSchema>;
export type ComputerConnectCodeIssueResponse = z.infer<typeof ComputerConnectCodeIssueResponseSchema>;
export type ComputerConnectCodeState = z.infer<typeof ComputerConnectCodeStateSchema>;
export type ComputerConnectCodeStatus = z.infer<typeof ComputerConnectCodeStatusSchema>;
export type AccountComputerConnectCodeCreateRequest = z.infer<typeof AccountComputerConnectCodeCreateRequestSchema>;
export type AccountComputerConnectCodeRepairRequest = z.infer<typeof AccountComputerConnectCodeRepairRequestSchema>;
export type AccountComputerConnectCodeIssueRequest = z.infer<typeof AccountComputerConnectCodeIssueRequestSchema>;
export type ComputerConnectionStatus = z.infer<typeof ComputerConnectionStatusSchema>;
export type ProviderReadinessStatus = z.infer<typeof ProviderReadinessStatusSchema>;
export type ImCliReadinessStatus = z.infer<typeof ImCliReadinessStatusSchema>;
export type ImCliProvider = z.infer<typeof ImCliProviderSchema>;
export type IntegrationCredentialExecutionStatus = z.infer<typeof IntegrationCredentialExecutionStatusSchema>;
export type IntegrationCredentialExecutionReason = z.infer<typeof IntegrationCredentialExecutionReasonSchema>;
export type ProviderCliValidationRetryReason = z.infer<typeof ProviderCliValidationRetryReasonSchema>;
export type ProviderCliValidationResultReason = z.infer<typeof ProviderCliValidationResultReasonSchema>;
export type ComputerProviderReadiness = z.infer<typeof ComputerProviderReadinessSchema>;
export type ComputerProviderReadinessCollection = z.infer<typeof ComputerProviderReadinessCollectionSchema>;
export type ComputerImCliReadiness = z.infer<typeof ComputerImCliReadinessSchema>;
export type ComputerImCliReadinessCollection = z.infer<typeof ComputerImCliReadinessCollectionSchema>;
