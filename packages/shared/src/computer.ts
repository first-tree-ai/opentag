import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);
export const ProviderReadinessStatusSchema = z.enum(["checking", "install", "sign-in", "ready", "unavailable"]);
export const ImCliReadinessStatusSchema = z.enum(["checking", "install", "ready", "unavailable"]);
export const IM_CLI_PROVIDERS = ["feishu", "slack"] as const;
export const ImCliProviderSchema = z.enum(IM_CLI_PROVIDERS);
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
    computerId: z.string().uuid(),
    installationId: z.string().uuid(),
    machineToken: z.string().min(1).max(4096),
  })
  .strict();

/** Empty body and `{ mode: "create" }` both issue a create code. */
export const AccountComputerConnectCodeCreateRequestSchema = z
  .object({
    mode: z.literal("create").optional(),
  })
  .strict();

/** Repair is Account-authorized and must name an explicit Computer owned by that Account. */
export const AccountComputerConnectCodeRepairRequestSchema = z
  .object({
    mode: z.literal("repair"),
    targetComputerId: z.string().uuid(),
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
export type ComputerProviderReadiness = z.infer<typeof ComputerProviderReadinessSchema>;
export type ComputerProviderReadinessCollection = z.infer<typeof ComputerProviderReadinessCollectionSchema>;
export type ComputerImCliReadiness = z.infer<typeof ComputerImCliReadinessSchema>;
export type ComputerImCliReadinessCollection = z.infer<typeof ComputerImCliReadinessCollectionSchema>;
