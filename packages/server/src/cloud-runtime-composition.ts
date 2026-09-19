import { CLOUD_MODEL_PROXY_PATH, sandboxRunnerWebSocketUrl } from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { CloudModelProxyRouteOptions } from "./api/cloud-model-proxy.js";
import type { CloudModelConfig } from "./cloud-model-config.js";
import type { ServerConfig } from "./config.js";
import type { DatabaseClient } from "./db/client.js";
import { agents, imBindings, sessions } from "./db/schema/index.js";
import type { ServiceLogger } from "./observability/service-logger.js";
import type { CloudSessionAllocationPort } from "./runtime/im-delivery-worker.types.js";
import type { RuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import type { RuntimeCredentialOwner } from "./runtime-credentials/runtime-credential-owner.js";
import {
  type AccessTokenProvider,
  CloudRunAdmin,
  createMetadataServerTokenProvider,
  createStaticTokenProvider,
} from "./services/cloud-run/index.js";
import { CloudDeliveryOwner, type CloudDeliveryOwnerOptions } from "./services/sandboxes/cloud-delivery-owner.js";
import { CloudModelGrantService } from "./services/sandboxes/cloud-model-grants.js";
import type { CloudRuntimeFence } from "./services/sandboxes/cloud-runtime-fence.js";
import {
  type CloudSessionCollaborationAllocationPort,
  CloudSessionCollaborationOwner,
  type CloudSessionCollaborationOwnerOptions,
} from "./services/sandboxes/cloud-session-collaboration-owner.js";
import type { SandboxService } from "./services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "./services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "./services/sandboxes/runner-hub.js";
import { RunnerWorkspaceService } from "./services/sandboxes/runner-workspace-service.js";
import {
  type SandboxAllocationReconciliation,
  SandboxRunnerService,
  type SandboxRunnerServiceOptions,
} from "./services/sandboxes/sandbox-runner-service.js";
import type { WorkspaceObjectStore } from "./services/sandboxes/workspace-object-store.js";
import { GcsWorkspaceObjectStore } from "./services/sandboxes/workspace-object-store.js";

export interface SandboxRunnerRuntime {
  sandboxRunnerService: SandboxRunnerService;
  runnerChannel: { tokens: RunnerBootstrapTokenService; hub: RunnerHub };
  /** E5 workspace HTTP authority; the production runtime always configures it with the store. */
  runnerWorkspace?: RunnerWorkspaceService;
}

export interface CloudDeliveryComposition {
  cloudModelGrants?: CloudModelGrantService;
  cloudDeliveryOwner?: CloudDeliveryOwner;
  cloudSessionOwner?: CloudSessionCollaborationOwner;
}

/**
 * E3–E5 Cloud Runner wiring, present only when explicitly enabled. Token acquisition is the GCE
 * metadata server in production; the acceptance harness may inject a short-lived static token
 * through the environment. The signing key for bootstrap tokens is the Server's own JWT secret
 * under a dedicated audience; no machine/daemon credential is reused for runners.
 *
 * E5: the workspace object store is always configured with the SAME Server Google token provider
 * the Cloud Run Admin uses, and production uses the GCS adapter. No Google credential ever
 * reaches a Runner; archive bytes cross only the authenticated workspace HTTP routes. The
 * composition regression calls this same factory, so a wiring drift (a missing workspace route,
 * a runner service without the store) is a test failure rather than a production surprise.
 */
export function createSandboxRunnerRuntime(
  database: DatabaseClient,
  config: Pick<ServerConfig, "environment" | "jwtSecret" | "cloudRunner" | "cloudIdentities">,
  options: {
    /** Tests inject a fake store factory; production defaults to the GCS object store adapter. */
    workspaceStoreFactory?: (input: { tokenProvider: AccessTokenProvider }) => WorkspaceObjectStore;
    sessionWorkBusy?: SandboxRunnerServiceOptions["sessionWorkBusy"];
    sessionWorkBarrier?: SandboxRunnerServiceOptions["sessionWorkBarrier"];
  } = {},
): SandboxRunnerRuntime | undefined {
  const cloudRunner = config.cloudRunner;
  if (!cloudRunner.enabled) return undefined;
  const cloudIdentities = config.cloudIdentities;
  if (!cloudIdentities.enabled) {
    throw new Error("Cloud Runner requires cloud identities (Runner build version) to be enabled");
  }
  const tokenProvider = cloudRunner.staticAccessToken
    ? createStaticTokenProvider(cloudRunner.staticAccessToken)
    : createMetadataServerTokenProvider();
  const cloudAdmin = new CloudRunAdmin(
    {
      project: cloudRunner.project,
      region: cloudRunner.region,
      serviceAccount: cloudRunner.serviceAccount,
      image: cloudRunner.image,
      vpc: cloudRunner.vpc,
      apiTimeoutMs: cloudRunner.apiTimeoutMs,
    },
    { tokenProvider },
  );
  const tokens = new RunnerBootstrapTokenService(config.jwtSecret, {
    ttlSeconds: cloudRunner.bootstrapTokenTtlSeconds,
  });
  const hub = new RunnerHub();
  const store = options.workspaceStoreFactory?.({ tokenProvider }) ?? new GcsWorkspaceObjectStore({ tokenProvider });
  const sandboxRunnerService = new SandboxRunnerService(database, {
    cloudAdmin,
    tokens,
    hub,
    environment: config.environment,
    backendUrl: sandboxRunnerWebSocketUrl(cloudRunner.backendOrigin),
    expectedRunnerVersion: cloudIdentities.runnerVersion,
    acceptanceTimeoutMs: cloudRunner.acceptanceTimeoutMs,
    createConvergeTimeoutMs: cloudRunner.createConvergeTimeoutMs,
    idleTimeoutMs: cloudRunner.idleTimeoutMs,
    workspace: { store },
    ...(options.sessionWorkBusy ? { sessionWorkBusy: options.sessionWorkBusy } : {}),
    ...(options.sessionWorkBarrier ? { sessionWorkBarrier: options.sessionWorkBarrier } : {}),
  });
  const runnerWorkspace = new RunnerWorkspaceService(database, {
    tokens,
    hub,
    store,
    runnerService: sandboxRunnerService,
  });
  return { sandboxRunnerService, runnerChannel: { tokens, hub }, runnerWorkspace };
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
  sessionProofs?: CloudDeliveryOwnerOptions["sessionProofs"];
  sessionCollaboration?: Pick<
    CloudSessionCollaborationOwnerOptions,
    "assembler" | "work" | "proofs" | "sessions" | "durableWork" | "allocation"
  >;
  allocationStatus?: (sandboxId: string) => Promise<SandboxAllocationReconciliation | undefined>;
  /** E7 business-activity clock from the allocation service; absent keeps Cloud delivery untracked. */
  noteActivity?: (sandboxId: string) => Promise<void>;
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
  const common = {
    database: input.database,
    fence: input.cloudRuntimeFence,
    hub: input.hub,
    ...(input.noteActivity ? { noteActivity: input.noteActivity } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.cloudModel.enabled ? { modelBaseUrl: `${input.publicUrl}${CLOUD_MODEL_PROXY_PATH}` } : {}),
    ...(cloudModelGrants ? { modelGrants: cloudModelGrants } : {}),
  };
  const cloudDeliveryOwner = new CloudDeliveryOwner({
    ...common,
    custody: input.custody,
    credentials: { owner: input.credentialOwner },
    ...(input.sessionProofs ? { sessionProofs: input.sessionProofs } : {}),
    ...(input.allocationStatus ? { allocationStatus: input.allocationStatus } : {}),
  });
  const cloudSessionOwner = input.sessionCollaboration
    ? new CloudSessionCollaborationOwner({
        ...common,
        ...input.sessionCollaboration,
      })
    : undefined;
  return { cloudModelGrants, cloudDeliveryOwner, cloudSessionOwner };
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

/** Internal children reuse the existing Session and Sandbox rows; visible targets already have a Sandbox. */
export function createCloudSessionAllocationPort(input: {
  database: DatabaseClient;
  sandboxService: Pick<SandboxService, "ensureForInternalSession">;
  sandboxRunnerService: Pick<SandboxRunnerService, "ensureIngressAllocation">;
}): CloudSessionCollaborationAllocationPort {
  return {
    async ensureSandbox(sessionId) {
      const [row] = await input.database
        .select({ accountId: agents.createdByUserId })
        .from(sessions)
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return undefined;
      const sandbox = await input.sandboxService.ensureForInternalSession(row.accountId, sessionId);
      return { sandboxId: sandbox.sandboxId, accountId: row.accountId };
    },
    ensureEnvironmentAllocated: ({ accountId, sandboxId }) =>
      input.sandboxRunnerService.ensureIngressAllocation(accountId, sandboxId),
  };
}

/** The createApp options fragment for the Cloud Runner channel and the controlled model path. */
export function cloudAppOptions(input: {
  runnerRuntime: SandboxRunnerRuntime | undefined;
  composition: CloudDeliveryComposition;
  cloudModel: CloudModelConfig;
}): {
  sandboxRunnerService?: SandboxRunnerService;
  runnerChannel?: {
    tokens: RunnerBootstrapTokenService;
    hub: RunnerHub;
    cloudDelivery?: CloudDeliveryOwner;
    cloudSession?: CloudSessionCollaborationOwner;
  };
  runnerWorkspace?: RunnerWorkspaceService;
  cloudModel?: CloudModelProxyRouteOptions;
} {
  const runnerOptions = sandboxRunnerRouteOptions(
    input.runnerRuntime,
    input.composition.cloudDeliveryOwner,
    input.composition.cloudSessionOwner,
  );
  return {
    ...runnerOptions,
    // The workspace routes exist exactly when the runtime configured persistence; without them a
    // workspace Runner can never claim/restore and fails closed before readiness.
    ...(input.runnerRuntime?.runnerWorkspace ? { runnerWorkspace: input.runnerRuntime.runnerWorkspace } : {}),
    ...(input.composition.cloudModelGrants && input.cloudModel.enabled
      ? { cloudModel: { config: input.cloudModel, grants: input.composition.cloudModelGrants } }
      : {}),
  };
}

/** Only pass the Runner route options when allocation is actually enabled. */
function sandboxRunnerRouteOptions(
  runtime: SandboxRunnerRuntime | undefined,
  cloudDelivery: CloudDeliveryOwner | undefined,
  cloudSession: CloudSessionCollaborationOwner | undefined,
):
  | {
      sandboxRunnerService: SandboxRunnerService;
      runnerChannel: {
        tokens: RunnerBootstrapTokenService;
        hub: RunnerHub;
        cloudDelivery?: CloudDeliveryOwner;
        cloudSession?: CloudSessionCollaborationOwner;
      };
    }
  | Record<string, never> {
  return runtime
    ? {
        sandboxRunnerService: runtime.sandboxRunnerService,
        runnerChannel: {
          tokens: runtime.runnerChannel.tokens,
          hub: runtime.runnerChannel.hub,
          ...(cloudDelivery ? { cloudDelivery } : {}),
          ...(cloudSession ? { cloudSession } : {}),
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
