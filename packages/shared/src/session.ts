import { z } from "zod";

export const SessionKindSchema = z.enum(["channel", "thread", "internal"]);

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    integrationId: z.string().uuid(),
    channelId: z.string().min(1).max(512),
    conversationKind: z.enum(["channel", "dm", "group_dm"]),
    kind: SessionKindSchema,
    threadKey: z.string().min(1).max(512).nullable(),
    createdBySessionId: z.string().uuid().nullable(),
    endedAt: z.string().datetime().nullable(),
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export const SessionPlacementSchema = z
  .object({
    sessionId: z.string().uuid(),
    computerId: z.string().uuid(),
    generation: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type SessionKind = z.infer<typeof SessionKindSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type SessionPlacement = z.infer<typeof SessionPlacementSchema>;
