import { z } from "zod";

export const ServerHealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("opentag-server"),
  })
  .strict();

export type ServerHealth = z.infer<typeof ServerHealthSchema>;

// `/healthz?deep=1` response. Kept separate from ServerHealthSchema so plain liveness consumers (doctor) keep a stable contract.
export const ServerDeepHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.literal("opentag-server"),
    checks: z.object({ database: z.enum(["ok", "fail", "unconfigured"]) }).strict(),
  })
  .strict();

export type ServerDeepHealth = z.infer<typeof ServerDeepHealthSchema>;
