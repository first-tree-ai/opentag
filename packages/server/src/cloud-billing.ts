import type {
  CloudBillingSummary,
  CloudCreditCheckoutRequest,
  CloudUsageSummary,
  CloudUsageWindowDays,
} from "@opentag/shared";
import type { CloudModelTransportLimits } from "./cloud-model-request.js";

/** Installed only in the hosted cloud image; the public server has no private dependency. */
export interface CloudBilling {
  readiness(): Promise<{ status: "ready"; revision: string | null }>;
  summary(accountId: string): Promise<CloudBillingSummary>;
  usage(accountId: string, windowDays: CloudUsageWindowDays): Promise<CloudUsageSummary>;
  checkout(accountId: string, input: CloudCreditCheckoutRequest): Promise<{ url: string }>;
  model(accountId: string, body: unknown, signal: AbortSignal, limits: CloudModelTransportLimits): Promise<Response>;
  webhook(payload: Buffer, signature: string | undefined): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
export interface CloudBillingModuleOptions {
  databaseUrl: string;
  publicUrl: string;
  environment: NodeJS.ProcessEnv;
  onError(event: string): void;
}
export type CloudBillingFactory = (options: CloudBillingModuleOptions) => Promise<CloudBilling>;

export {
  applyCloudModelOutputBudget,
  CLOUD_MODEL_ERROR_BODY_MAX_BYTES,
  CloudModelRequestSchema,
  type CloudModelTransportLimits,
  CloudModelTransportLimitsSchema,
} from "./cloud-model-request.js";
