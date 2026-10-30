import type { DatabaseClient } from "../../db/client.js";
import {
  type GitHubMcpAuthorityFence,
  gitHubMcpFence,
  gitHubMcpReadOnly,
  readAgentGitHubMcp,
} from "../mcp/github-authorization.js";
import { mcpEffectiveConfig } from "../mcp/mcp-authorization-graph.js";
import type { McpAuthorizationService } from "../mcp/mcp-authorization-service.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import type { GitHubApiClient } from "./github-api-client.js";
import { GitHubRepositoryAdmissionService } from "./repository-admission.js";

export interface AgentGitHubConnection {
  id: string;
  accountId: string;
  authorizationVersion: string;
  credentialGeneration: string;
  readOnly?: boolean;
  fence?: GitHubMcpAuthorityFence;
}

export interface GitHubExecutionCredentialRequest {
  accountId: string;
  agentId: string;
  connectionId: string;
  authorizationRevision: string;
  signal?: AbortSignal;
}

export interface GitHubExecutionCredentialReader {
  getExecutionUserCredential(input: GitHubExecutionCredentialRequest): Promise<{
    accessToken: string;
    credentialGeneration: bigint;
    readOnly?: boolean;
  } | null>;
}

export class AgentGitHubAuthorizationError extends Error {
  constructor(readonly code: "github_connector_disabled" | "github_connector_unsupported") {
    super(code);
    this.name = "AgentGitHubAuthorizationError";
  }
}

export class AgentGitHubCredentialService implements GitHubExecutionCredentialReader {
  readonly #admission: GitHubRepositoryAdmissionService;
  constructor(
    readonly options: {
      database: DatabaseClient;
      authorization: Pick<McpAuthorizationService, "resolveAccessCredential">;
      api: GitHubApiClient;
      configured: boolean;
      trustedClient(url: string, issuer: string, clientId: string | undefined, registrationId: string | null): boolean;
    },
  ) {
    this.#admission = new GitHubRepositoryAdmissionService({ api: options.api });
  }

  async #resolve(accountId: string, agentId: string) {
    if (!this.options.configured) return undefined;
    const context = await readAgentGitHubMcp(this.options.database, accountId, agentId);
    if (context && !context.binding.enabled) throw new AgentGitHubAuthorizationError("github_connector_disabled");
    if (context?.authorization && context.authorization.kind !== "oauth")
      throw new AgentGitHubAuthorizationError("github_connector_unsupported");
    const fence = context && gitHubMcpFence(context);
    if (!context || !fence) return undefined;
    const credential = this.options.authorization.resolveAccessCredential(context);
    if (
      !credential ||
      !this.options.trustedClient(
        mcpEffectiveConfig(context.server, context.binding).url,
        context.authorization?.authorizationServer ?? "",
        credential.clientId,
        context.authorization?.clientRegistrationId ?? null,
      )
    )
      return undefined;
    const connection: AgentGitHubConnection = {
      id: context.server.id,
      accountId,
      authorizationVersion: fence.authorizationVersion,
      credentialGeneration: String(context.credentialAuthorization?.refreshGeneration),
      readOnly: gitHubMcpReadOnly(context),
      fence,
    };
    return { connection, accessToken: credential.accessToken };
  }

  async getOverview(accountId: string, agentId: string) {
    const resolved = await this.#resolve(accountId, agentId);
    return { connection: resolved?.connection ?? null };
  }

  async getExecutionUserCredential(
    input: GitHubExecutionCredentialRequest,
  ): ReturnType<GitHubExecutionCredentialReader["getExecutionUserCredential"]> {
    input.signal?.throwIfAborted();
    const current = await this.#resolve(input.accountId, input.agentId);
    input.signal?.throwIfAborted();
    if (
      !current ||
      current.connection.id !== input.connectionId ||
      `github:${current.connection.authorizationVersion}` !== input.authorizationRevision
    )
      return null;
    return {
      accessToken: current.accessToken,
      credentialGeneration: BigInt(current.connection.credentialGeneration),
      readOnly: current.connection.readOnly,
    };
  }

  async resolveRepository(input: {
    accountId: string;
    agentId: string;
    connectionId: string;
    expectedAuthorizationVersion: string;
    fullName: string;
    access: "read" | "write";
    signal?: AbortSignal;
  }) {
    const current = await this.#resolve(input.accountId, input.agentId);
    if (!current || current.connection.id !== input.connectionId) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND,
        401,
        "This Agent has no usable GitHub MCP authorization",
      );
    }
    if (current.connection.authorizationVersion !== input.expectedAuthorizationVersion)
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT,
        409,
        "GitHub MCP authorization changed",
      );
    if (input.access === "write" && current.connection.readOnly)
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT,
        403,
        "This GitHub Connector is read-only",
      );
    const target = await this.#admission.resolveRepository({ ...input, accessToken: current.accessToken });
    return { ...target, authorizationVersion: current.connection.authorizationVersion };
  }
}
