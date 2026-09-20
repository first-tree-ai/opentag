import type { CloudAvailability } from "@opentag/shared";
import type { ServerConfig } from "./config.js";

/**
 * The deployment's Cloud product availability, projected from startup-validated configuration.
 *
 * This is a configuration fact, never a probe: `available` means the platform is configured to
 * start an execution environment for a real task (identities, Runner allocation, and the brokered
 * model path all enabled), not that an environment is already running or was validated. The three
 * legs are deliberately kept apart so a reader can tell "the product is not offered here" from
 * "offered, but execution cannot start" from "execution works but no model is configured".
 *
 * Configuration is all-or-nothing at startup, so a running Server's answer is stable per process;
 * `now` only timestamps the observation.
 */
export function cloudAvailability(
  config: Pick<ServerConfig, "cloudIdentities" | "cloudRunner" | "cloudModel">,
  now: Date = new Date(),
): CloudAvailability {
  const observedAt = now.toISOString();
  if (!config.cloudIdentities.enabled) {
    return { enabled: false, available: false, reason: "disabled", observedAt };
  }
  if (!config.cloudRunner.enabled) {
    return { enabled: true, available: false, reason: "execution_unavailable", observedAt };
  }
  if (!config.cloudModel.enabled) {
    return { enabled: true, available: false, reason: "model_unavailable", observedAt };
  }
  return { enabled: true, available: true, reason: null, observedAt };
}
