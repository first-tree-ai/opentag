import { z } from "zod";

const tokens = z.number().int().safe().nonnegative();
export const CloudCallContextSchema = z
  .object({
    accountId: z.string().uuid(),
    agentId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    source: z.enum(["execution", "connectivity_probe"]),
  })
  .strict();
export type CloudCallContext = z.infer<typeof CloudCallContextSchema>;
export const CloudModelReferenceSchema = z
  .object({ gateway: z.string().min(1).max(256), model: z.string().min(1).max(128) })
  .strict();
export type CloudModelReference = z.infer<typeof CloudModelReferenceSchema>;
export const CloudTokenRatesSchema = z
  .object({
    inputMicrosPerMillion: tokens,
    cachedInputMicrosPerMillion: tokens,
    outputMicrosPerMillion: tokens,
  })
  .strict();
export type CloudTokenRates = z.infer<typeof CloudTokenRatesSchema>;
export const CloudUsageObservationSchema = z
  .object({
    responseId: z.string().min(1).max(256).optional(),
    providerCallId: z.string().min(1).max(256).optional(),
    inputTokens: tokens.optional(),
    cachedInputTokens: tokens.optional(),
    outputTokens: tokens.optional(),
    complete: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.cachedInputTokens === undefined ||
      value.inputTokens === undefined ||
      value.cachedInputTokens <= value.inputTokens,
    "Cached input exceeds total input",
  );
export type CloudUsageObservation = z.infer<typeof CloudUsageObservationSchema>;
export const CloudCallOutcomeSchema = z.enum(["finished", "not_sent"]);
export type CloudCallOutcome = z.infer<typeof CloudCallOutcomeSchema>;
