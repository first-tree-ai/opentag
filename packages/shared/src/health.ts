import { z } from "zod";

export const ServerHealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("opentag-server"),
  })
  .strict();

export type ServerHealth = z.infer<typeof ServerHealthSchema>;
