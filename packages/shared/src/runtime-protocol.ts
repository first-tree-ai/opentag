import { z } from "zod";
import { ComputerPlatformSchema } from "./computer.js";
import { ErrorCodeSchema } from "./errors.js";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const RuntimeRequestIdSchema = z.string().uuid();

export const ServerWelcomeFrameSchema = z
  .object({
    type: z.literal("server:welcome"),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    heartbeatIntervalMs: z.number().int().positive(),
    heartbeatTimeoutMs: z.number().int().positive(),
  })
  .strict();

export const AuthFrameSchema = z
  .object({ type: z.literal("auth"), requestId: RuntimeRequestIdSchema, accessToken: z.string().min(1).max(4096) })
  .strict();
export const AuthResultFrameSchema = z
  .object({
    type: z.literal("auth:result"),
    requestId: RuntimeRequestIdSchema,
    ok: z.boolean(),
    userId: z.string().uuid().optional(),
    tokenExpiresAt: z.string().datetime().optional(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.ok && (!frame.userId || !frame.tokenExpiresAt)) {
      context.addIssue({ code: "custom", message: "A successful auth result requires user identity and expiry" });
    }
    if (!frame.ok && !frame.errorCode) {
      context.addIssue({ code: "custom", message: "A failed auth result requires an error code" });
    }
  });
export const ComputerRegisterFrameSchema = z
  .object({
    type: z.literal("computer:register"),
    requestId: RuntimeRequestIdSchema,
    computerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(255),
    platform: ComputerPlatformSchema,
    arch: z.string().trim().min(1).max(64),
    clientVersion: z.string().trim().min(1).max(64),
  })
  .strict();
export const ComputerRegisterResultFrameSchema = z
  .object({
    type: z.literal("computer:register:result"),
    requestId: RuntimeRequestIdSchema,
    ok: z.boolean(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (!frame.ok && !frame.errorCode) {
      context.addIssue({ code: "custom", message: "A failed register result requires an error code" });
    }
  });
export const HeartbeatFrameSchema = z
  .object({
    type: z.literal("heartbeat"),
    requestId: RuntimeRequestIdSchema,
    computerId: z.string().uuid(),
    instanceId: z.string().uuid(),
  })
  .strict();
export const HeartbeatResultFrameSchema = z
  .object({
    type: z.literal("heartbeat:result"),
    requestId: RuntimeRequestIdSchema,
    ok: z.boolean(),
    serverTime: z.string().datetime(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (!frame.ok && !frame.errorCode) {
      context.addIssue({ code: "custom", message: "A failed heartbeat result requires an error code" });
    }
  });
export const RuntimeErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    requestId: RuntimeRequestIdSchema.optional(),
    code: ErrorCodeSchema,
    message: z.string().min(1).max(512),
  })
  .strict();

export const ClientRuntimeFrameSchema = z.discriminatedUnion("type", [
  AuthFrameSchema,
  ComputerRegisterFrameSchema,
  HeartbeatFrameSchema,
  RuntimeErrorFrameSchema,
]);
export const ServerRuntimeFrameSchema = z.discriminatedUnion("type", [
  ServerWelcomeFrameSchema,
  AuthResultFrameSchema,
  ComputerRegisterResultFrameSchema,
  HeartbeatResultFrameSchema,
  RuntimeErrorFrameSchema,
]);

export type ServerWelcomeFrame = z.infer<typeof ServerWelcomeFrameSchema>;
export type AuthFrame = z.infer<typeof AuthFrameSchema>;
export type AuthResultFrame = z.infer<typeof AuthResultFrameSchema>;
export type ComputerRegisterFrame = z.infer<typeof ComputerRegisterFrameSchema>;
export type ComputerRegisterResultFrame = z.infer<typeof ComputerRegisterResultFrameSchema>;
export type HeartbeatFrame = z.infer<typeof HeartbeatFrameSchema>;
export type HeartbeatResultFrame = z.infer<typeof HeartbeatResultFrameSchema>;
export type RuntimeErrorFrame = z.infer<typeof RuntimeErrorFrameSchema>;
export type ClientRuntimeFrame = z.infer<typeof ClientRuntimeFrameSchema>;
export type ServerRuntimeFrame = z.infer<typeof ServerRuntimeFrameSchema>;
