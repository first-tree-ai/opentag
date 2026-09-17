import type { RuntimeCredentialServerFrame } from "@opentag/shared";
import type { ServerConfig } from "./config.js";
import type { DatabaseClient } from "./db/client.js";
import type { ServiceLogger } from "./observability/service-logger.js";
import type { ConnectionRegistry, RuntimeControlIdentity } from "./runtime/connection-registry.js";
import type { RuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import {
  createRuntimeCredentialServices,
  KindAwareComputerAuthVerifier,
  type RuntimeConnectionFence,
  type RuntimeControlAuthority,
  RuntimeExecutionRegistry,
  type TrustedCloudControlAuthority,
} from "./runtime-credentials/index.js";
import { AuthServiceError } from "./services/auth/index.js";
import type { ComputerAuthContext, ComputerAuthVerifier } from "./services/computers/index.js";
import type { ApplicationCipher } from "./services/crypto.js";
import type { GitHubIntegrationComposition } from "./services/github/composition.js";
import { GitHubInstallationTokenClient } from "./services/github/installation-token-client.js";
import { GitPublicationGuard } from "./services/github-proxy/git-publication.js";
import { GitReadTransport } from "./services/github-proxy/git-read-transport.js";
import { GitWorkspace } from "./services/github-proxy/git-workspace.js";
import { GitHubProviderAdapter } from "./services/github-proxy/github-provider-adapter.js";
import { GitHubIatLeases } from "./services/github-proxy/iat-leases.js";
import { GitHubRuntimePolicy } from "./services/github-proxy/runtime-policy.js";
import { VerifiedTreeHead } from "./services/github-proxy/verified-tree-head.js";

/**
 * Server-owned assembly: only opaque capabilities cross the runtime control connection. The
 * composition is stateless beyond PostgreSQL and bounded memory: there is no persistent control
 * volume, no file-backed write journal, and no additional file-backed Cloud credential store.
 * Git staging uses disposable temporary workspaces that are removed on a normal close and are
 * never restored as authority after a restart.
 *
 * E4 adds a second, independent Cloud control authority: the per-Sandbox Runner connection
 * fence. It is composed with the Local registry for credential opens/sweeps/revocation routing,
 * while the optional injected `cloudControl` verifier keeps its own Computer-level authority.
 */
export async function createPlatformRuntime(options: {
  config: ServerConfig;
  database: DatabaseClient;
  cipher: ApplicationCipher;
  registry: ConnectionRegistry;
  custody: RuntimeCustodyStore;
  machineAuth: ComputerAuthVerifier;
  github?: GitHubIntegrationComposition;
  /**
   * Explicit trusted Cloud control verifier/activity port, owned by Computer/Cloud
   * orchestration. The default startup injects no verifier/activity checker: Cloud control
   * authentication and Cloud credential activity checks then fail closed, while Local keeps its
   * existing machine-token path and its Local-only restriction.
   */
  cloudControl?: TrustedCloudControlAuthority;
  logger?: ServiceLogger;
  /**
   * E4 Cloud Runner connection fence: composed with the Local registry fence so credential
   * executions opened over the per-Sandbox Runner channel pass the broker/data-transport exact
   * connection checks. The Local registry and Computer online state stay untouched.
   */
  cloudRuntimeFence?: RuntimeConnectionFence & { isControlActive(identity: RuntimeControlIdentity): boolean };
  /**
   * Exact Cloud revocation routing (credential owner -> Cloud controller). The owner invalidates
   * Server-side first and only then notifies the exact owning connection.
   */
  cloudRevocationSender?: (computerId: string, instanceId: string, frame: RuntimeCredentialServerFrame) => void;
}) {
  const cloudControl = options.cloudControl;
  const cloudControlActive = createCloudControlActive(options);
  const executions = new RuntimeExecutionRegistry();
  const policy = options.github
    ? new GitHubRuntimePolicy({
        database: options.database,
        management: options.github.management,
        execution: executions,
      })
    : undefined;
  let workspace: GitWorkspace | undefined;
  let github: GitHubProviderAdapter | undefined;
  if (policy && options.config.githubApp) {
    // Ephemeral Git staging: the exclusive temporary root is created lazily on the first Git
    // operation and removed on close. Construction itself performs no filesystem writes; a
    // partial-construction failure disposes anything already created.
    workspace = new GitWorkspace();
    try {
      const staging = workspace;
      github = new GitHubProviderAdapter({
        policy,
        leases: new GitHubIatLeases(new GitHubInstallationTokenClient(options.config.githubApp), () =>
          options.logger?.warn({ code: "iat_revoke_failed" }, "GitHub installation token revocation failed"),
        ),
        reads: new GitReadTransport({ workspace: staging }),
        publication: new GitPublicationGuard({ workspace: staging }),
        treeHeads: new VerifiedTreeHead({ workspace: staging }),
      });
    } catch (error) {
      await workspace.close();
      throw error;
    }
  }
  const controlAuthority = createCloudControlAuthority(options);
  const credentials = createRuntimeCredentialServices({
    database: options.database,
    cipher: options.cipher,
    registry: options.registry,
    custody: options.custody,
    executions,
    ...(cloudControlActive ? { cloudControlActive } : {}),
    ...(controlAuthority ? { controlAuthority } : {}),
    ...(options.cloudRuntimeFence ? { additionalConnectionFence: options.cloudRuntimeFence } : {}),
    ...(policy ? { taskPolicy: policy, gitHubAdmission: policy } : {}),
    ...(github ? { adapters: new Map([["github", github]]) } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const unsubscribe = executions.onClose(({ executionId }) => {
    void github
      ?.closeExecution(executionId)
      .catch(() => options.logger?.warn({ code: "iat_revoke_failed" }, "GitHub credential cleanup failed"));
  });
  return {
    credentials,
    auth: new KindAwareComputerAuthVerifier(
      options.machineAuth,
      options.database,
      options.config.cloudIdentities.enabled ? cloudControl : undefined,
    ),
    assertCloudControlCredential: async (identity: ComputerAuthContext) => {
      if (
        !options.config.cloudIdentities.enabled ||
        identity.kind !== "cloud" ||
        !cloudControl ||
        !(await cloudControl.isActive(controlFacts(identity)))
      )
        throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The Cloud control credential is invalid", 401);
    },
    close: async () => {
      credentials.close();
      unsubscribe();
      try {
        await github?.close();
      } finally {
        // The ephemeral workspace root is removed even when GitHub credential cleanup fails.
        await workspace?.close();
      }
    },
  };
}

/**
 * Cloud credential activity: the exact live native Runner connection OR the injected trusted
 * verifier. Both obey `config.cloudIdentities.enabled`; absent or denied checks fail closed.
 */
function createCloudControlActive(options: {
  config: ServerConfig;
  cloudControl?: TrustedCloudControlAuthority;
  cloudRuntimeFence?: RuntimeConnectionFence & { isControlActive(identity: RuntimeControlIdentity): boolean };
}): ((identity: RuntimeControlIdentity) => Promise<boolean>) | undefined {
  const fence = options.cloudRuntimeFence;
  const verifier = options.cloudControl;
  if (!options.config.cloudIdentities.enabled || (!fence && !verifier)) return undefined;
  return async (identity: RuntimeControlIdentity): Promise<boolean> => {
    if (fence?.isControlActive(identity) === true) return true;
    return verifier ? await verifier.isActive(controlFacts(identity)) : false;
  };
}

/**
 * Composed Local + Cloud control authority for the credential owner (open/sweep/revocation):
 * either fence recognizes the exact connection, and revocation reaches the exact owning channel.
 */
function createCloudControlAuthority(options: {
  registry: ConnectionRegistry;
  cloudRuntimeFence?: RuntimeConnectionFence & { isControlActive(identity: RuntimeControlIdentity): boolean };
  cloudRevocationSender?: (computerId: string, instanceId: string, frame: RuntimeCredentialServerFrame) => void;
}): RuntimeControlAuthority | undefined {
  const fence = options.cloudRuntimeFence;
  if (!fence) return undefined;
  return {
    isCurrentConnection: (computerId, instanceId, connectionId) =>
      options.registry.isCurrentConnection(computerId, instanceId, connectionId) ||
      fence.isCurrent(computerId, instanceId, connectionId),
    currentInstanceId: (computerId) => options.registry.currentInstanceId(computerId),
    currentControlIdentity: (computerId) =>
      options.registry.currentControlIdentity(computerId) ?? fence.currentControlIdentity?.(computerId),
    sendRevoked: (computerId, instanceId, frame) => {
      void options.registry.send(computerId, instanceId, frame).catch(() => undefined);
      options.cloudRevocationSender?.(computerId, instanceId, frame);
    },
  };
}

function controlFacts(identity: { credentialId: string; computerId: string; installationId: string }) {
  return {
    credentialId: identity.credentialId,
    computerId: identity.computerId,
    installationId: identity.installationId,
  };
}
