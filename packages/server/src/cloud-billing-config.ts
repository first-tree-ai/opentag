import { z } from "zod";

export type CloudBillingConfig = { enabled: boolean };

export function resolveCloudBillingConfig(environment: NodeJS.ProcessEnv): CloudBillingConfig {
  return {
    enabled: z.enum(["true", "false"]).default("false").parse(environment.OPENTAG_CLOUD_BILLING_ENABLED) === "true",
  };
}
