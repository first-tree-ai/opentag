/*
 * Real composition of the GitHub management plane: one factory wires the bounded API transport,
 * OAuth orchestration, admission verification, the Account-facing management facade, the
 * maintenance worker, and the webhook ingress from the deployment configuration. The Server
 * bootstrap calls this only when the GitHub App is coherently configured; routes receive the
 * facade, the webhook handler, and explicit availability metadata either way.
 */

import type { DatabaseClient } from "../../db/client.js";
import type { GitHubCredentialCipher } from "../github-credential-material.js";
import { GitHubApiClient } from "./github-api-client.js";
import { GitHubBindingsService } from "./github-bindings-service.js";
import { GitHubConnectionService } from "./github-connection-service.js";
import { GitHubMaintenanceWorker, type GitHubMaintenanceWorkerOptions } from "./github-maintenance-worker.js";
import { GitHubManagementService } from "./github-management-service.js";
import { GitHubOAuthService } from "./github-oauth-service.js";
import { GitHubConnectionRecheckStore } from "./github-recheck-store.js";
import { GitHubCredentialRefreshStore } from "./github-refresh-store.js";
import { GitHubWebhookService } from "./github-webhook.js";
import { GitHubRepositoryAdmissionService } from "./repository-admission.js";

/** The management plane's configuration: the deployment App without its IAT-only private key. */
export interface GitHubIntegrationConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Exact OAuth callback URL on this Server's public origin. */
  oauthCallbackUrl: string;
}

export interface GitHubIntegrationComposition {
  management: GitHubManagementService;
  worker: GitHubMaintenanceWorker;
  webhook: GitHubWebhookService;
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
  const bindings = new GitHubBindingsService(options.database, { now });
  const admission = new GitHubRepositoryAdmissionService({ api, appId: options.config.appId, now });
  const oauth = new GitHubOAuthService({
    connections,
    cipher: options.cipher,
    api,
    clientId: options.config.clientId,
    redirectUri: options.config.oauthCallbackUrl,
  });
  const management = new GitHubManagementService({
    database: options.database,
    appId: options.config.appId,
    connections,
    bindings,
    oauth,
    admission,
    cipher: options.cipher,
    now,
  });
  const refreshStore = new GitHubCredentialRefreshStore(options.database, { now });
  const recheckStore = new GitHubConnectionRecheckStore(options.database, { now });
  const worker = new GitHubMaintenanceWorker({
    refreshStore,
    recheckStore,
    cipher: options.cipher,
    api,
    admission,
    now,
    ...(options.worker?.intervalMs !== undefined ? { intervalMs: options.worker.intervalMs } : {}),
    ...(options.worker?.tickBudgetMs !== undefined ? { tickBudgetMs: options.worker.tickBudgetMs } : {}),
    ...(options.worker?.batchLimit !== undefined ? { batchLimit: options.worker.batchLimit } : {}),
    ...(options.worker?.refreshWithinMs !== undefined ? { refreshWithinMs: options.worker.refreshWithinMs } : {}),
    ...(options.worker?.logger ? { logger: options.worker.logger } : {}),
  });
  const webhook = new GitHubWebhookService({
    webhookSecret: options.config.webhookSecret,
    recheckStore,
    now,
  });
  return { management, worker, webhook };
}
