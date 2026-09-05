import { z } from "zod";

export const RuntimeOwnershipHealthSchema = z
  .object({
    mode: z.literal("single"),
    status: z.enum(["owned", "not_owned"]),
    instanceId: z.string().uuid().optional(),
  })
  .strict();

export type RuntimeOwnershipHealth = z.infer<typeof RuntimeOwnershipHealthSchema>;

export const ServerHealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("opentag-server"),
    runtimeOwnership: RuntimeOwnershipHealthSchema,
  })
  .strict();

export type ServerHealth = z.infer<typeof ServerHealthSchema>;
