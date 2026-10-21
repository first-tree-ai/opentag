/* Compose the OAuth management facade and the credential maintenance worker. */

import type { DatabaseClient } from "../../db/client.js";
import type { GitHubCredentialCipher } from "../github-credential-material.js";
import { GitHubApiClient } from "./github-api-client.js";
import { GitHubConnectionService } from "./github-connection-service.js";
import { GitHubMaintenanceWorker, type GitHubMaintenanceWorkerOptions } from "./github-maintenance-worker.js";
import { GitHubManagementService } from "./github-management-service.js";
import { GitHubOAuthService } from "./github-oauth-service.js";
import { GitHubConnectionRecheckStore } from "./github-recheck-store.js";
import { GitHubCredentialRefreshStore } from "./github-refresh-store.js";
import { GitHubRepositoryAdmissionService } from "./repository-admission.js";

/** The deployment OAuth App configuration. */
export interface GitHubIntegrationConfig {
  clientId: string;
  clientSecret: string;
  /** Exact OAuth callback URL on this Server's public origin. */
  oauthCallbackUrl: string;
}

export interface GitHubIntegrationComposition {
  management: GitHubManagementService;
  worker: GitHubMaintenanceWorker;
}

export function createGitHubIntegration(options: {
  database: DatabaseClient;
  config: GitHubIntegrationConfig;
  cipher: GitHubCredentialCipher;
  fetch?: typeof fetch;
  now?: () => Date;
  worker?: Pick<
    GitHubMaintenanceWorkerOptions,
    "intervalMs" | "tickBudgetMs" | "batchLimit" | "refreshWithinMs" | "logger"
  >;
}): GitHubIntegrationComposition {
  const now = options.now ?? (() => new Date());
  const api = new GitHubApiClient({
    clientId: options.config.clientId,
    clientSecret: options.config.clientSecret,
    redirectUri: options.config.oauthCallbackUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
  });
  const connections = new GitHubConnectionService(options.database, { now });
  const admission = new GitHubRepositoryAdmissionService({ api });
  const oauth = new GitHubOAuthService({
    connections,
    cipher: options.cipher,
    api,
    clientId: options.config.clientId,
    redirectUri: options.config.oauthCallbackUrl,
  });
  const management = new GitHubManagementService({
    database: options.database,
    oauthClientId: options.config.clientId,
    connections,
    oauth,
    admission,
    cipher: options.cipher,
    now,
  });
  const refreshStore = new GitHubCredentialRefreshStore(options.database, {
    now,
    oauthClientId: options.config.clientId,
  });
  const recheckStore = new GitHubConnectionRecheckStore(options.database, {
    now,
    oauthClientId: options.config.clientId,
  });
  const worker = new GitHubMaintenanceWorker({
    refreshStore,
    recheckStore,
    cipher: options.cipher,
    api,
    now,
    ...(options.worker?.intervalMs !== undefined ? { intervalMs: options.worker.intervalMs } : {}),
    ...(options.worker?.tickBudgetMs !== undefined ? { tickBudgetMs: options.worker.tickBudgetMs } : {}),
    ...(options.worker?.batchLimit !== undefined ? { batchLimit: options.worker.batchLimit } : {}),
    ...(options.worker?.refreshWithinMs !== undefined ? { refreshWithinMs: options.worker.refreshWithinMs } : {}),
    ...(options.worker?.logger ? { logger: options.worker.logger } : {}),
  });
  return { management, worker };
}
