import type { CloudBillingSummary, CloudCreditCheckoutRequest } from "@opentag/shared";
import type { CloudCallContext, CloudCallOutcome, CloudModelReference } from "./cloud-call-contracts.js";

export * from "./cloud-call-contracts.js";

/** Installed only in the hosted image. Provider HTTP and response parsing belong to the public server. */
export interface CloudBilling {
  readiness(): Promise<{ status: "ready"; revision: string | null }>;
  pricedModels(gateway: string): string[];
  beginCall(context: CloudCallContext, model: CloudModelReference): Promise<string>;
  finishCall(callId: string, outcome: CloudCallOutcome): Promise<void>;
  writeOffCall(callId: string, reason: string): Promise<void>;
  summary(accountId: string): Promise<CloudBillingSummary>;
  checkout(accountId: string, input: CloudCreditCheckoutRequest): Promise<{ url: string }>;
  webhook(payload: Buffer, signature: string | undefined): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
export interface CloudBillingModuleOptions {
  databaseUrl: string;
  publicUrl: string;
  environment: NodeJS.ProcessEnv;
}
export type CloudBillingFactory = (options: CloudBillingModuleOptions) => Promise<CloudBilling>;
export {
  type CloudCall,
  CloudCallSchema,
  CloudCallStore,
  type CloudQueryConnection,
} from "./services/cloud-call-store.js";
