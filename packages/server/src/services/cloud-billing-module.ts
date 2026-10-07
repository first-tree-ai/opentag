import type { CloudBilling, CloudBillingFactory, CloudBillingModuleOptions } from "../cloud-billing.js";

const packageName = "@opentag/cloud-billing";

/** A variable import keeps ordinary public builds independent of the private package. */
export async function loadCloudBilling(
  enabled: boolean,
  options: CloudBillingModuleOptions,
  load: (name: string) => Promise<{ createCloudBilling: CloudBillingFactory }> = (name) => import(name),
): Promise<CloudBilling | undefined> {
  if (!enabled) return undefined;
  if (options.environment.OPENTAG_CLOUD_MODEL_ENABLED !== "true")
    throw new Error("Cloud billing requires cloud models");
  try {
    const module = await load(packageName);
    const billing = await module.createCloudBilling(options);
    const methods = ["readiness", "summary", "usage", "checkout", "model", "webhook", "stop", "close"] as const;
    if (!billing || methods.some((name) => typeof billing[name] !== "function"))
      throw new Error("Invalid cloud billing module");
    return billing;
  } catch {
    throw new Error("Cloud billing initialization failed; check the installed module, configuration and database");
  }
}
