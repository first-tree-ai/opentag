import { z } from "zod";

/**
 * What the running image can do, stamped by the Dockerfile target: `bundled` by the `cloud` target,
 * `absent` by the ordinary `runtime` target. Unset outside those images, where the runtime flag alone
 * decides and a missing package fails initialization explicitly.
 */
export type CloudBillingCapability = "bundled" | "absent" | "unspecified";

export type CloudBillingConfig = {
  /** Effective state: billing is initialized only when the image can bill and the flag asks for it. */
  enabled: boolean;
  /** The runtime flag as configured, kept so a flag the image cannot honour is reported, not hidden. */
  requested: boolean;
  capability: CloudBillingCapability;
};

const CapabilitySchema = z.enum(["bundled", "absent"]).optional();

export function resolveCloudBillingConfig(environment: NodeJS.ProcessEnv): CloudBillingConfig {
  const requested =
    z.enum(["true", "false"]).default("false").parse(environment.OPENTAG_CLOUD_BILLING_ENABLED) === "true";
  const capability =
    CapabilitySchema.parse(environment.OPENTAG_CLOUD_BILLING_CAPABILITY?.trim() || undefined) ?? "unspecified";
  return { enabled: requested && capability !== "absent", requested, capability };
}

/** True when the flag asks for billing but the image deliberately ships without it. */
export function isCloudBillingFlagIgnored(config: CloudBillingConfig): boolean {
  return config.requested && !config.enabled;
}
