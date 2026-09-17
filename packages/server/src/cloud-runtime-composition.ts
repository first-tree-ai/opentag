import { CLOUD_MODEL_PROXY_PATH } from "@opentag/shared";
import type { CloudModelProxyRouteOptions } from "./api/cloud-model-proxy.js";
import type { CloudModelConfig } from "./cloud-model-config.js";
import type { DatabaseClient } from "./db/client.js";
import type { ServiceLogger } from "./observability/service-logger.js";
import type { CloudSessionAllocationPort } from "./runtime/im-delivery-worker.types.js";
import type { RuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import type { RuntimeCredentialOwner } from "./runtime-credentials/runtime-credential-owner.js";
import { CloudDeliveryOwner } from "./services/sandboxes/cloud-delivery-owner.js";
import { CloudModelGrantService } from "./services/sandboxes/cloud-model-grants.js";
import type { CloudRuntimeFence } from "./services/sandboxes/cloud-runtime-fence.js";
import type { SandboxService } from "./services/sandboxes/index.js";
import type { RunnerBootstrapTokenService } from "./services/sandboxes/runner-bootstrap-token.js";
import type { RunnerHub } from "./services/sandboxes/runner-hub.js";
import type {
  SandboxAllocationReconciliation,
  SandboxRunnerService,
} from "./services/sandboxes/sandbox-runner-service.js";

export interface SandboxRunnerRuntime {
  sandboxRunnerService: SandboxRunnerService;
  runnerChannel: { tokens: RunnerBootstrapTokenService; hub: RunnerHub };
}

export interface CloudDeliveryComposition {
  cloudModelGrants?: CloudModelGrantService;
  cloudDeliveryOwner?: CloudDeliveryOwner;
}

/**
 * The exact E4 Cloud delivery composition production startup uses: one grant service instance and
 * one owner, wired to the composed credential owner and the existing allocation service. The
 * entrypoint composition regression calls this same factory, so a wiring drift here is a test
 * failure rather than a 404 (or an unregistered model route) in production.
 */
export function createCloudDeliveryComposition(input: {
  cloudModel: CloudModelConfig;
  jwtSecret: string;
  publicUrl: string;
  database: DatabaseClient;
  custody: RuntimeCustodyStore;
  hub?: RunnerHub;
  cloudRuntimeFence?: CloudRuntimeFence;
  credentialOwner: RuntimeCredentialOwner;
  allocationStatus?: (sandboxId: string) => Promise<SandboxAllocationReconciliation | undefined>;
  logger?: ServiceLogger;
}): CloudDeliveryComposition {
  if (!input.cloudRuntimeFence || !input.hub) return {};
  const cloudModelGrants = input.cloudModel.enabled
    ? new CloudModelGrantService(input.jwtSecret, {
        allowedModels: input.cloudModel.allowedModels,
        maxStreamsPerToken: input.cloudModel.maxStreamsPerToken,
        ttlSeconds: input.cloudModel.tokenTtlSeconds,
      })
    : undefined;
  const cloudDeliveryOwner = new CloudDeliveryOwner({
    custody: input.custody,
    database: input.database,
    fence: input.cloudRuntimeFence,
    hub: input.hub,
    credentials: { owner: input.credentialOwner },
    ...(input.allocationStatus ? { allocationStatus: input.allocationStatus } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.cloudModel.enabled ? { modelBaseUrl: `${input.publicUrl}${CLOUD_MODEL_PROXY_PATH}` } : {}),
    ...(cloudModelGrants ? { modelGrants: cloudModelGrants } : {}),
  });
  return { cloudModelGrants, cloudDeliveryOwner };
}

/**
 * The normal-ingress allocation port: the worker talks only to these narrow methods, and the real
 * SandboxService/SandboxRunnerService (with their injected Cloud API) own every allocation effect.
 */
export function createCloudIngressAllocationPort(input: {
  sandboxService: Pick<SandboxService, "ensureForAccount">;
  sandboxRunnerService: Pick<SandboxRunnerService, "ensureIngressAllocation">;
}): CloudSessionAllocationPort {
  return {
    ensureSandbox: async (sessionInput) => {
      const request =
        sessionInput.kind === "thread"
          ? {
              imBindingId: sessionInput.imBindingId,
              channelId: sessionInput.channelId,
              conversationKind: sessionInput.conversationKind,
              kind: "thread" as const,
              threadKey: sessionInput.threadKey,
            }
          : {
              imBindingId: sessionInput.imBindingId,
              channelId: sessionInput.channelId,
              conversationKind: sessionInput.conversationKind,
              kind: "channel" as const,
            };
      const sandbox = await input.sandboxService.ensureForAccount(sessionInput.accountId, request);
      return { sandboxId: sandbox.sandboxId };
    },
    ensureEnvironmentAllocated: (environmentInput) =>
      input.sandboxRunnerService.ensureIngressAllocation(environmentInput.accountId, environmentInput.sandboxId),
  };
}

/** The createApp options fragment for the Cloud Runner channel and the controlled model path. */
export function cloudAppOptions(input: {
  runnerRuntime: SandboxRunnerRuntime | undefined;
  composition: CloudDeliveryComposition;
  cloudModel: CloudModelConfig;
}): {
  sandboxRunnerService?: SandboxRunnerService;
  runnerChannel?: { tokens: RunnerBootstrapTokenService; hub: RunnerHub; cloudDelivery?: CloudDeliveryOwner };
  cloudModel?: CloudModelProxyRouteOptions;
} {
  const runnerOptions = sandboxRunnerRouteOptions(input.runnerRuntime, input.composition.cloudDeliveryOwner);
  return {
    ...runnerOptions,
    ...(input.composition.cloudModelGrants && input.cloudModel.enabled
      ? { cloudModel: { config: input.cloudModel, grants: input.composition.cloudModelGrants } }
      : {}),
  };
}

/** Only pass the Runner route options when allocation is actually enabled. */
function sandboxRunnerRouteOptions(
  runtime: SandboxRunnerRuntime | undefined,
  cloudDelivery: CloudDeliveryOwner | undefined,
):
  | {
      sandboxRunnerService: SandboxRunnerService;
      runnerChannel: { tokens: RunnerBootstrapTokenService; hub: RunnerHub; cloudDelivery?: CloudDeliveryOwner };
    }
  | Record<string, never> {
  return runtime
    ? {
        sandboxRunnerService: runtime.sandboxRunnerService,
        runnerChannel: {
          tokens: runtime.runnerChannel.tokens,
          hub: runtime.runnerChannel.hub,
          ...(cloudDelivery ? { cloudDelivery } : {}),
        },
      }
    : {};
}

/**
 * Every configured value startup errors must never echo, including the raw key ring JSON. Exported
 * so the composition regression can prove the Cloud model master key is included, with a
 * fixture-only sentinel and no real environment secret.
 */
export function collectKnownSecrets(environment: NodeJS.ProcessEnv): string[] {
  return [
    environment.OPENTAG_DATABASE_URL ?? "",
    environment.OPENTAG_JWT_SECRET ?? "",
    environment.BETTER_AUTH_SECRET ?? "",
    environment.OPENTAG_GOOGLE_CLIENT_SECRET ?? "",
    environment.OPENTAG_ENCRYPTION_KEY ?? "",
    environment.OPENTAG_ENCRYPTION_KEY_RING ?? "",
    environment.OPENTAG_OTEL_HEADERS ?? "",
    environment.OPENTAG_SLACK_CLIENT_SECRET ?? "",
    environment.OPENTAG_SLACK_SIGNING_SECRET ?? "",
    environment.OPENTAG_GITHUB_APP_CLIENT_SECRET ?? "",
    environment.OPENTAG_GITHUB_APP_PRIVATE_KEY ?? "",
    environment.OPENTAG_GITHUB_APP_WEBHOOK_SECRET ?? "",
    // The Cloud model master key authorizes real upstream spend; it is never printed or echoed.
    environment.OPENTAG_CLOUD_MODEL_MASTER_KEY ?? "",
    // The dev-only static Cloud Runner token is a live Google access token while it is set.
    environment.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN ?? "",
  ];
}
