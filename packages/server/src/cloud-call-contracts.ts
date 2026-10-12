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
    cacheWriteInputMicrosPerMillion: tokens,
    outputMicrosPerMillion: tokens,
  })
  .strict();
export type CloudTokenRates = z.infer<typeof CloudTokenRatesSchema>;
/** Router-normalized input includes disjoint cache-read and cache-write subsets. */
export const CloudTokenUsageSchema = z
  .object({
    inputTokens: tokens,
    cachedInputTokens: tokens,
    cacheWriteInputTokens: tokens,
    outputTokens: tokens,
  })
  .strict()
  .refine(
    (value) => value.cachedInputTokens + value.cacheWriteInputTokens <= value.inputTokens,
    "Cache tokens exceed total input",
  );
export type CloudTokenUsage = z.infer<typeof CloudTokenUsageSchema>;
export const CloudCallResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete"), usage: CloudTokenUsageSchema }).strict(),
  z.object({ status: z.literal("no_charge") }).strict(),
]);
export type CloudCallResult = z.infer<typeof CloudCallResultSchema>;
