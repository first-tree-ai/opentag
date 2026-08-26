import { z } from "zod";
import { MeWorkspaceSchema } from "./auth.js";

export const InvitationTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const InvitationPreviewSchema = z
  .object({
    workspaceDisplayName: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const InvitationAcceptanceResponseSchema = z.object({ workspace: MeWorkspaceSchema }).strict();

export type InvitationToken = z.infer<typeof InvitationTokenSchema>;
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;
export type InvitationAcceptanceResponse = z.infer<typeof InvitationAcceptanceResponseSchema>;
