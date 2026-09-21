import { z } from "zod";
import { DEFAULT_CLOUD_CAPACITY_LIMITS } from "./services/sandboxes/sandbox-capacity.js";

/**
 * E3 Cloud Runner configuration: derived, never independently switched. The overall Cloud switch
 * (OPENTAG_CLOUD_IDENTITIES_ENABLED) enables the Runner; there is no separate Runner flag. The
 * retired OPENTAG_CLOUD_RUNNER_ENABLED is checked only for malformed or conflicting upgrade
 * settings. An agreeing "true" remains tolerated during the older Server rollback window.
 * When enabled, every
 * coordinate the Server needs to allocate Cloud Run Instances is validated up front — the
 * digest-pinned Runner image, project/region/service account, the WSS backend origin Runners dial
 * back to, and the Direct VPC attachment (network/subnetwork/execution tag, ALL_TRAFFIC egress).
 * There is no partial enablement: a missing value fails startup rather than degrading to a default
 * egress path.
 */

const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_REGION_PATTERN = /^[a-z]+-[a-z]+[0-9]$/;
const GCP_NETWORK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const GCP_SERVICE_ACCOUNT_PATTERN =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
/** Exact digest-pinned image reference; tags are never accepted for the Runner image. */
const DIGEST_PINNED_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,254}@sha256:[0-9a-f]{64}$/;

const BackendOriginSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    const protocolOk = url.protocol === "https:" || url.protocol === "wss:";
    if (!protocolOk || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      context.addIssue({
        code: "custom",
        message: "Must be an HTTPS/WSS origin without credentials, path, query, or fragment",
      });
      return z.NEVER;
    }
    return url.origin.replace(/^wss:/, "https:");
  });

export const CloudRunnerEnvironmentSchema = z
  .object({
    OPENTAG_CLOUD_RUNNER_IMAGE: z.string().trim().regex(DIGEST_PINNED_IMAGE_PATTERN).optional(),
    OPENTAG_CLOUD_RUNNER_PROJECT: z.string().trim().regex(GCP_PROJECT_ID_PATTERN).optional(),
    OPENTAG_CLOUD_RUNNER_REGION: z.string().trim().regex(GCP_REGION_PATTERN).optional(),
    OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: z.string().trim().regex(GCP_SERVICE_ACCOUNT_PATTERN).optional(),
    OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: BackendOriginSchema.optional(),
    OPENTAG_CLOUD_RUNNER_VPC_NETWORK: z.string().trim().regex(GCP_NETWORK_NAME_PATTERN).optional(),
    OPENTAG_CLOUD_RUNNER_VPC_SUBNET: z.string().trim().regex(GCP_NETWORK_NAME_PATTERN).optional(),
    OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: z.string().trim().regex(GCP_NETWORK_NAME_PATTERN).optional(),
    /*
     * Acceptance-harness token injection. Production never sets this: the Server acquires access
     * tokens from the GCE metadata server of the service account it runs as. A static token here
     * exists so the maintained acceptance harness can run the Server off-GCP with a short-lived
     * token the operator supplied through the environment (never a file, never gcloud shell-out).
     */
    OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN: z.string().min(1).max(8192).optional(),
    OPENTAG_CLOUD_RUNNER_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    OPENTAG_CLOUD_RUNNER_CREATE_CONVERGE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
    OPENTAG_CLOUD_RUNNER_BOOTSTRAP_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(7_200).default(1_800),
    OPENTAG_CLOUD_RUNNER_ACCEPTANCE_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(1_800_000).default(900_000),
    /*
     * E7 single idle budget. Automatic reclamation seals and deletes a ready environment with no
     * business activity for this long. A same-account borrow is on demand for any quiescent
     * candidate and is NOT gated on this budget. There is deliberately no second
     * retention/tuning window.
     */
    OPENTAG_CLOUD_RUNNER_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
    /*
     * E9 admission ceilings: occupied Instances per Account and platform-wide, counted from the
     * durable Sandbox facts; lowering them only blocks NEW reservations, never kills running work.
     * The defaults are single-sourced from DEFAULT_CLOUD_CAPACITY_LIMITS, which the Sandbox
     * admission path also uses.
     */
    OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(DEFAULT_CLOUD_CAPACITY_LIMITS.accountLimit),
    OPENTAG_CLOUD_RUNNER_MAX_INSTANCES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(DEFAULT_CLOUD_CAPACITY_LIMITS.platformLimit),
  })
  .strict();

export type CloudRunnerEnvironment = z.infer<typeof CloudRunnerEnvironmentSchema>;

export type CloudRunnerConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Exact digest-pinned Runner image (`name@sha256:…`); never a tag. */
      image: string;
      project: string;
      region: string;
      serviceAccount: string;
      /** HTTPS origin of this Server the Runner dials back to (derived to WSS at use). */
      backendOrigin: string;
      vpc: { network: string; subnetwork: string; executionTag: string };
      /** Static acceptance-harness token; absent in production (metadata server is used). */
      staticAccessToken?: string;
      apiTimeoutMs: number;
      createConvergeTimeoutMs: number;
      bootstrapTokenTtlSeconds: number;
      acceptanceTimeoutMs: number;
      idleTimeoutMs: number;
      /** E9 admission ceiling: occupied Instances per Account (durable Sandbox occupancy). */
      maxInstancesPerAccount: number;
      /** E9 admission ceiling: occupied Instances platform-wide. */
      maxInstances: number;
    };

const REQUIRED_FIELDS = [
  "OPENTAG_CLOUD_RUNNER_IMAGE",
  "OPENTAG_CLOUD_RUNNER_PROJECT",
  "OPENTAG_CLOUD_RUNNER_REGION",
  "OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT",
  "OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN",
  "OPENTAG_CLOUD_RUNNER_VPC_NETWORK",
  "OPENTAG_CLOUD_RUNNER_VPC_SUBNET",
  "OPENTAG_CLOUD_RUNNER_EXECUTION_TAG",
] as const;

/**
 * Parse the runner environment slice. Enablement derives from the overall Cloud switch alone:
 * identities on means the Runner must be fully configured; identities off disables the Runner
 * regardless of any leftover runner coordinates or the retired per-Runner flag.
 */
export function resolveCloudRunnerConfig(
  environment: NodeJS.ProcessEnv,
  cloudIdentitiesEnabled: boolean,
): CloudRunnerConfig {
  validateRetiredRunnerEnabled(environment, cloudIdentitiesEnabled);
  const parsed = CloudRunnerEnvironmentSchema.parse({
    OPENTAG_CLOUD_RUNNER_IMAGE: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_IMAGE),
    OPENTAG_CLOUD_RUNNER_PROJECT: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_PROJECT),
    OPENTAG_CLOUD_RUNNER_REGION: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_REGION),
    OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT),
    OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN),
    OPENTAG_CLOUD_RUNNER_VPC_NETWORK: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_VPC_NETWORK),
    OPENTAG_CLOUD_RUNNER_VPC_SUBNET: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_VPC_SUBNET),
    OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_EXECUTION_TAG),
    OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN: emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN),
    OPENTAG_CLOUD_RUNNER_API_TIMEOUT_MS: environment.OPENTAG_CLOUD_RUNNER_API_TIMEOUT_MS,
    OPENTAG_CLOUD_RUNNER_CREATE_CONVERGE_TIMEOUT_MS: environment.OPENTAG_CLOUD_RUNNER_CREATE_CONVERGE_TIMEOUT_MS,
    OPENTAG_CLOUD_RUNNER_BOOTSTRAP_TOKEN_TTL_SECONDS: environment.OPENTAG_CLOUD_RUNNER_BOOTSTRAP_TOKEN_TTL_SECONDS,
    OPENTAG_CLOUD_RUNNER_ACCEPTANCE_TIMEOUT_MS: environment.OPENTAG_CLOUD_RUNNER_ACCEPTANCE_TIMEOUT_MS,
    OPENTAG_CLOUD_RUNNER_IDLE_TIMEOUT_MS: environment.OPENTAG_CLOUD_RUNNER_IDLE_TIMEOUT_MS,
    OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT: environment.OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT,
    OPENTAG_CLOUD_RUNNER_MAX_INSTANCES: environment.OPENTAG_CLOUD_RUNNER_MAX_INSTANCES,
  });
  if (!cloudIdentitiesEnabled) return { enabled: false };
  if (parsed.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN && environment.OPENTAG_ENV !== "dev") {
    throw new Error(
      "Static Cloud Runner access tokens require explicit OPENTAG_ENV=dev; hosted servers use service identity",
    );
  }
  const missing = REQUIRED_FIELDS.filter((field) => parsed[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `OPENTAG_CLOUD_IDENTITIES_ENABLED=true enables the Cloud Runner, but required configuration is missing: ${missing.join(", ")}`,
    );
  }
  return {
    enabled: true,
    image: parsed.OPENTAG_CLOUD_RUNNER_IMAGE as string,
    project: parsed.OPENTAG_CLOUD_RUNNER_PROJECT as string,
    region: parsed.OPENTAG_CLOUD_RUNNER_REGION as string,
    serviceAccount: parsed.OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT as string,
    backendOrigin: parsed.OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN as string,
    vpc: {
      network: parsed.OPENTAG_CLOUD_RUNNER_VPC_NETWORK as string,
      subnetwork: parsed.OPENTAG_CLOUD_RUNNER_VPC_SUBNET as string,
      executionTag: parsed.OPENTAG_CLOUD_RUNNER_EXECUTION_TAG as string,
    },
    ...(parsed.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN
      ? { staticAccessToken: parsed.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN }
      : {}),
    apiTimeoutMs: parsed.OPENTAG_CLOUD_RUNNER_API_TIMEOUT_MS,
    createConvergeTimeoutMs: parsed.OPENTAG_CLOUD_RUNNER_CREATE_CONVERGE_TIMEOUT_MS,
    bootstrapTokenTtlSeconds: parsed.OPENTAG_CLOUD_RUNNER_BOOTSTRAP_TOKEN_TTL_SECONDS,
    acceptanceTimeoutMs: parsed.OPENTAG_CLOUD_RUNNER_ACCEPTANCE_TIMEOUT_MS,
    idleTimeoutMs: parsed.OPENTAG_CLOUD_RUNNER_IDLE_TIMEOUT_MS,
    maxInstancesPerAccount: parsed.OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT,
    maxInstances: parsed.OPENTAG_CLOUD_RUNNER_MAX_INSTANCES,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reject silent activation of a previously paused Runner; this does not restore a third switch. */
function validateRetiredRunnerEnabled(environment: NodeJS.ProcessEnv, cloudIdentitiesEnabled: boolean): void {
  const retired = emptyToUndefined(environment.OPENTAG_CLOUD_RUNNER_ENABLED);
  if (retired === undefined) return;
  if (retired !== "true" && retired !== "false") {
    throw new Error(
      'OPENTAG_CLOUD_RUNNER_ENABLED is retired and no longer switches the Cloud Runner; remove it from the deployment (only "true"/"false" remain recognizable migration values)',
    );
  }
  if (retired === "false" && cloudIdentitiesEnabled) {
    throw new Error(
      "OPENTAG_CLOUD_RUNNER_ENABLED=false no longer pauses the Cloud Runner: OPENTAG_CLOUD_IDENTITIES_ENABLED=true now enables it. Remove the retired variable to keep Cloud on, or set OPENTAG_CLOUD_IDENTITIES_ENABLED=false to keep execution off",
    );
  }
}
