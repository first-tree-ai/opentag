import { z } from "zod";
import { AGENT_RUNTIME_PROVIDERS, AgentRuntimeProviderSchema } from "./agent.js";

export const ComputerPlatformSchema = z.enum(["darwin", "linux", "win32"]);
export const ComputerConnectionStatusSchema = z.enum(["online", "offline"]);
export const ProviderReadinessStatusSchema = z.enum(["checking", "install", "sign-in", "ready", "unavailable"]);
export const ImCliReadinessStatusSchema = z.enum(["checking", "install", "ready", "unavailable"]);
export const IM_CLI_PROVIDERS = ["feishu", "slack"] as const;
export const ImCliProviderSchema = z.enum(IM_CLI_PROVIDERS);
export const PROVIDER_READINESS_V1_HEADER = "x-opentag-provider-readiness";

export const ComputerConnectCodeExchangeRequestSchema = z
  .object({
    code: z.string().trim().min(16).max(512),
    computerId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
  })
  .strict();

export const ComputerConnectCodeExchangeResponseSchema = z
  .object({
    workspaceComputerId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    computerId: z.string().uuid(),
    machineToken: z.string().min(1).max(4096),
  })
  .strict();

export const ComputerConnectCodeIssueRequestSchema = z.object({ workspaceId: z.string().uuid() }).strict();

/**
 * The Account-native connect-code request carries no scope: the issuing Account comes from the access
 * token alone, so any client-selected `workspaceId` or `accountId` is rejected rather than ignored.
 */
export const AccountComputerConnectCodeIssueRequestSchema = z.object({}).strict();

export const ComputerConnectCodeIssueResponseSchema = z
  .object({
    bootstrapCommand: z.string().min(1),
    expiresIn: z.number().int().positive(),
    issuedAt: z.string().datetime(),
  })
  .strict();

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
export type ComputerConnectCodeExchangeRequest = z.infer<typeof ComputerConnectCodeExchangeRequestSchema>;
export type ComputerConnectCodeExchangeResponse = z.infer<typeof ComputerConnectCodeExchangeResponseSchema>;
export type ComputerConnectCodeIssueRequest = z.infer<typeof ComputerConnectCodeIssueRequestSchema>;
export type ComputerConnectCodeIssueResponse = z.infer<typeof ComputerConnectCodeIssueResponseSchema>;
export type AccountComputerConnectCodeIssueRequest = z.infer<typeof AccountComputerConnectCodeIssueRequestSchema>;
export type ComputerConnectionStatus = z.infer<typeof ComputerConnectionStatusSchema>;
export type ProviderReadinessStatus = z.infer<typeof ProviderReadinessStatusSchema>;
export type ImCliReadinessStatus = z.infer<typeof ImCliReadinessStatusSchema>;
export type ImCliProvider = z.infer<typeof ImCliProviderSchema>;
export type ComputerProviderReadiness = z.infer<typeof ComputerProviderReadinessSchema>;
export type ComputerProviderReadinessCollection = z.infer<typeof ComputerProviderReadinessCollectionSchema>;
export type ComputerImCliReadiness = z.infer<typeof ComputerImCliReadinessSchema>;
export type ComputerImCliReadinessCollection = z.infer<typeof ComputerImCliReadinessCollectionSchema>;
