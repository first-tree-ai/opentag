import { z } from "zod";
import { SlackProvisionCredentialsSchema } from "./slack-agent-provision.js";

export const SlackAutoSetupRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("authorize"), force: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("connect"), challenge: z.string().trim().min(1).max(256).optional() }).strict(),
]);
export const SlackAutoSetupFailureSchema = z.enum([
  "computer_unavailable",
  "capability_missing",
  "busy",
  "authorization_failed",
  "create_failed",
  "create_uncertain",
  "install_failed",
  "approval_denied",
  "callbacks_failed",
  "manual_required",
  "failed",
]);
export const SlackAutoSetupResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authorization_required"), ticket: z.string().min(1).max(512) }).strict(),
  z.object({ status: z.literal("authorized"), teamName: z.string() }).strict(),
  z.object({ status: z.literal("connected") }).strict(),
  z.object({ status: z.literal("approval_pending"), appId: z.string().min(1), teamId: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal("failed"),
      code: SlackAutoSetupFailureSchema,
      appId: z.string().min(1).optional(),
      teamId: z.string().min(1).optional(),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]{1,63}$/)
        .optional(),
    })
    .strict(),
]);
export const SlackAutoSetupCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("authorize"), force: z.boolean().optional() }).strict(),
  z
    .object({
      action: z.literal("install"),
      displayName: z.string().min(1).max(256),
      challenge: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("callbacks"),
      challenge: z.string().min(1).max(256).optional(),
      teamId: z.string().min(1),
      botUserId: z.string().min(1),
      enterpriseId: z.string().nullable(),
      appId: z.string().min(1),
      eventsUrl: z.string().url(),
      interactionsUrl: z.string().url(),
    })
    .strict(),
]);
export const SlackAutoSetupRuntimeRequestSchema = z
  .object({
    type: z.literal("slack:auto-setup"),
    requestId: z.string().uuid(),
    computerId: z.string().uuid(),
    agentId: z.string().uuid(),
    input: SlackAutoSetupCommandSchema,
  })
  .strict();
export const SlackAutoSetupRuntimeResultSchema = z
  .object({
    type: z.literal("slack:auto-setup:result"),
    requestId: z.string().uuid(),
    result: z.union([
      SlackAutoSetupResponseSchema,
      z.object({ status: z.literal("installed"), credentials: SlackProvisionCredentialsSchema }).strict(),
    ]),
  })
  .strict();
export type SlackAutoSetupRequest = z.infer<typeof SlackAutoSetupRequestSchema>;
export type SlackAutoSetupResponse = z.infer<typeof SlackAutoSetupResponseSchema>;
export type SlackAutoSetupCommand = z.infer<typeof SlackAutoSetupCommandSchema>;
export type SlackAutoSetupRuntimeRequest = z.infer<typeof SlackAutoSetupRuntimeRequestSchema>;
export type SlackAutoSetupRuntimeResult = z.infer<typeof SlackAutoSetupRuntimeResultSchema>;
