import { z } from "zod";

/**
 * E3 Cloud Runner configuration: opt-in, disabled by default. When enabled, every coordinate the
 * Server needs to allocate Cloud Run Instances is validated up front — the digest-pinned Runner
 * image, project/region/service account, the WSS backend origin Runners dial back to, and the
 * Direct VPC attachment (network/subnetwork/execution tag, ALL_TRAFFIC egress). There is no
 * partial enablement: a missing value fails startup rather than degrading to a default egress path.
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
    OPENTAG_CLOUD_RUNNER_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
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

/** Parse the runner environment slice; issues are reported against the enabling flag. */
export function resolveCloudRunnerConfig(
  environment: NodeJS.ProcessEnv,
  cloudIdentitiesEnabled: boolean,
): CloudRunnerConfig {
  const parsed = CloudRunnerEnvironmentSchema.parse({
    OPENTAG_CLOUD_RUNNER_ENABLED: environment.OPENTAG_CLOUD_RUNNER_ENABLED,
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
  });
  if (!parsed.OPENTAG_CLOUD_RUNNER_ENABLED) return { enabled: false };
  if (parsed.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN && environment.OPENTAG_ENV !== "dev") {
    throw new Error(
      "Static Cloud Runner access tokens require explicit OPENTAG_ENV=dev; hosted servers use service identity",
    );
  }
  const missing = REQUIRED_FIELDS.filter((field) => parsed[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`Cloud Runner is enabled without required configuration: ${missing.join(", ")}`);
  }
  if (!cloudIdentitiesEnabled) {
    throw new Error("Cloud Runner requires OPENTAG_CLOUD_IDENTITIES_ENABLED=true (Sandbox identities)");
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
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
