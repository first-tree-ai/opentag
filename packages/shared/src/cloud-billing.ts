import { z } from "zod";

export const CLOUD_BILLING_PATH = "/api/v1/cloud/billing";
export const CLOUD_BILLING_CHECKOUT_PATH = `${CLOUD_BILLING_PATH}/checkout`;

const money = z.number().int().safe().nonnegative();
export const CloudCreditCheckoutRequestSchema = z
  .object({
    amountCents: z.number().int().min(1000).max(100_000),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type CloudCreditCheckoutRequest = z.infer<typeof CloudCreditCheckoutRequestSchema>;

export const CloudCreditCheckoutResponseSchema = z
  .object({
    url: z.url().refine((value) => new URL(value).origin === "https://checkout.stripe.com"),
  })
  .strict();

export const CloudBillingSummarySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      currency: z.literal("USD"),
      availableMicros: money,
      blocked: z.boolean(),
      minimumTopUpCents: z.number().int().min(1000).max(100_000),
      maximumTopUpCents: z.number().int().min(1000).max(100_000),
    })
    .strict(),
]);
export type CloudBillingSummary = z.infer<typeof CloudBillingSummarySchema>;

export const CLOUD_USAGE_PATH = `${CLOUD_BILLING_PATH}/usage`;
export const CloudUsageWindowDaysSchema = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]);
export type CloudUsageWindowDays = z.infer<typeof CloudUsageWindowDaysSchema>;
export const CloudUsageQuerySchema = z
  .object({
    windowDays: z.coerce.number().pipe(CloudUsageWindowDaysSchema).default(30),
  })
  .strict();
export const CloudUsageSummarySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      windowDays: CloudUsageWindowDaysSchema,
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime(),
      requests: money,
      measuredRequests: money,
      inputTokens: money,
      outputTokens: money,
      tokens: money,
      daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: money }).strict()).max(91),
    })
    .strict()
    .refine(
      (value) => value.measuredRequests <= value.requests && value.tokens === value.inputTokens + value.outputTokens,
      { message: "Invalid cloud usage totals" },
    ),
]);
export type CloudUsageSummary = z.infer<typeof CloudUsageSummarySchema>;
