import type {
  CloudBillingSummary,
  CloudCreditCheckoutRequest,
  CloudUsageSummary,
  CloudUsageWindowDays,
} from "@opentag/shared";

/** Installed only in the hosted cloud image; the public server has no private dependency. */
export interface CloudBilling {
  readiness(): Promise<{ status: "ready"; revision: string | null }>;
  summary(accountId: string): Promise<CloudBillingSummary>;
  usage(accountId: string, windowDays: CloudUsageWindowDays): Promise<CloudUsageSummary>;
  checkout(accountId: string, input: CloudCreditCheckoutRequest): Promise<{ url: string }>;
  model(accountId: string, body: unknown, signal: AbortSignal): Promise<Response>;
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
