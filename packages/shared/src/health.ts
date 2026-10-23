import { z } from "zod";

export const ServerHealthSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("opentag-server"),
  })
  .strict();

export type ServerHealth = z.infer<typeof ServerHealthSchema>;

// `/healthz?deep=1` response. Kept separate from ServerHealthSchema so plain liveness consumers (doctor) keep a stable contract.
// `status` and `checks.database` are coupled by the union: the route only ever produces these three combinations, so the
// public schema must not accept a self-contradictory body such as `status: "ok"` with `database: "fail"`.
export const ServerDeepHealthSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      service: z.literal("opentag-server"),
      checks: z.object({ database: z.enum(["ok", "unconfigured"]) }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("degraded"),
      service: z.literal("opentag-server"),
      checks: z.object({ database: z.literal("fail") }).strict(),
    })
    .strict(),
]);

export type ServerDeepHealth = z.infer<typeof ServerDeepHealthSchema>;
