import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import type { DatabaseClient } from "./db/client.js";
import type { ServiceLogger } from "./observability/service-logger.js";
import type { ConnectionRegistry } from "./runtime/connection-registry.js";
import type { RuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import {
  createRuntimeCredentialServices,
  KindAwareComputerAuthVerifier,
  RuntimeExecutionRegistry,
} from "./runtime-credentials/index.js";
import { AuthServiceError } from "./services/auth/index.js";
import { FileCloudControlAuthority } from "./services/cloud-control-authority.js";
import type { ComputerAuthContext, ComputerAuthVerifier } from "./services/computers/index.js";
import type { ApplicationCipher } from "./services/crypto.js";
import type { GitHubIntegrationComposition } from "./services/github/composition.js";
import { GitHubInstallationTokenClient } from "./services/github/installation-token-client.js";
import { GitPublicationGuard } from "./services/github-proxy/git-publication.js";
import { GitReadTransport } from "./services/github-proxy/git-read-transport.js";
import { GitHubProviderAdapter } from "./services/github-proxy/github-provider-adapter.js";
import { GitHubIatLeases } from "./services/github-proxy/iat-leases.js";
import { GitHubRuntimePolicy } from "./services/github-proxy/runtime-policy.js";
import { VerifiedTreeHead } from "./services/github-proxy/verified-tree-head.js";
import { FileSessionControlStore } from "./services/session-control-store/index.js";
import { ensureControlDirectory } from "./services/session-control-store/private-files.js";

/** Server-owned assembly: only opaque capabilities cross the runtime control connection. */
export async function createPlatformRuntime(options: {
  config: ServerConfig;
  database: DatabaseClient;
  cipher: ApplicationCipher;
  registry: ConnectionRegistry;
  custody: RuntimeCustodyStore;
  machineAuth: ComputerAuthVerifier;
  github?: GitHubIntegrationComposition;
  logger?: ServiceLogger;
}) {
  const root = options.config.runtimeControlDirectory;
  await ensureControlDirectory(root);
  const store = new FileSessionControlStore({ root: join(root, "sessions") });
  const cloudControl = new FileCloudControlAuthority({
    root: join(root, "cloud-control"),
    onRevoked: async (identity) => {
      const current = options.registry.currentControlIdentity(identity.computerId);
      if (current?.credentialId === identity.credentialId) await options.registry.closeComputer(identity.computerId);
    },
  });
  const executions = new RuntimeExecutionRegistry();
  const policy = options.github
    ? new GitHubRuntimePolicy({
        database: options.database,
        management: options.github.management,
        execution: executions,
      })
    : undefined;
  const github =
    policy && options.config.githubApp
      ? new GitHubProviderAdapter({
          policy,
          leases: new GitHubIatLeases(new GitHubInstallationTokenClient(options.config.githubApp), () =>
            options.logger?.warn({ code: "iat_revoke_failed" }, "GitHub installation token revocation failed"),
          ),
          reads: new GitReadTransport({ root: join(root, "git-reads"), controlStore: store }),
          publication: new GitPublicationGuard({ root: join(root, "git-publications"), controlStore: store }),
          treeHeads: new VerifiedTreeHead({ root: join(root, "tree-heads"), store }),
          store,
        })
      : undefined;
  const credentials = createRuntimeCredentialServices({
    database: options.database,
    cipher: options.cipher,
    registry: options.registry,
    custody: options.custody,
    executions,
    cloudControlActive: (identity) =>
      options.config.cloudIdentities.enabled && cloudControl.isActive(controlFacts(identity)),
    writeJournal: store,
    sourceRecorder: store,
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
    store,
    cloudControl,
    auth: new KindAwareComputerAuthVerifier(
      options.machineAuth,
      options.database,
      options.config.cloudIdentities.enabled ? cloudControl : undefined,
    ),
    assertCloudControlCredential: async (identity: ComputerAuthContext) => {
      if (
        !options.config.cloudIdentities.enabled ||
        identity.kind !== "cloud" ||
        !(await cloudControl.isActive(controlFacts(identity)))
      )
        throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The Cloud control credential is invalid", 401);
    },
    close: async () => {
      credentials.close();
      unsubscribe();
      await github?.close();
    },
  };
}

function controlFacts(identity: ComputerAuthContext) {
  return {
    credentialId: identity.credentialId,
    computerId: identity.computerId,
    installationId: identity.installationId,
  };
}
