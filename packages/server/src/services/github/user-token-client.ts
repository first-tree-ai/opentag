import { GitPublicationError } from "../github-proxy/git-packets.js";
import { type GitHubApiClient, GitHubApiClientError } from "./github-api-client.js";
import type { GitHubManagementService } from "./github-management-service.js";
import {
  ownedScopedToken,
  scopedTokenCandidate,
  validateScopedToken,
  validateUserTokenInput,
} from "./user-token-scope.js";
import type { GitHubExecutionUserCredential, GitHubUserTokenInput } from "./user-token-types.js";

/** User identity with one repository and explicit permissions. All material stays on the Server. */
export class GitHubUserTokenClient {
  constructor(
    readonly options: {
      api: Pick<GitHubApiClient, "createScopedUserToken" | "listInstallationRepositories" | "revokeUserToken">;
      management: Pick<GitHubManagementService, "getExecutionUserCredential" | "isCurrentUserCredential">;
      clientId: string;
      now?: () => Date;
      onRevokeFailure?: () => void;
    },
  ) {}

  async mint(input: GitHubUserTokenInput): Promise<{ token: string; expiresAt: Date }> {
    const repositoryId = validateUserTokenInput(input);
    try {
      // One fresh parent is allowed after concurrent refresh, before any repository operation.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await this.#mintAttempt(input, repositoryId);
        if (result) return result;
      }
      throw new GitPublicationError("scope_denied");
    } catch (error) {
      // No fetch error/cause may carry a parent token, Basic secret or response body outward.
      if (error instanceof GitHubApiClientError)
        throw new GitHubApiClientError(error.code, error.message, error.details);
      if (error instanceof GitPublicationError) throw error;
      throw new GitPublicationError("unavailable");
    }
  }

  async #mintAttempt(input: GitHubUserTokenInput, repositoryId: number) {
    input.signal?.throwIfAborted();
    const parent = await this.options.management.getExecutionUserCredential(input);
    if (!parent || parent.accessExpiresAt.getTime() <= this.#now() + 5_000)
      throw new GitPublicationError("scope_denied");
    const scoped = await this.#scope(input, repositoryId, parent);
    if (!scoped) return null;
    const candidate = scopedTokenCandidate(scoped.payload);
    let retained = false;
    try {
      const token = ownedScopedToken(scoped.payload, parent, this.options.clientId);
      const expiresAt = validateScopedToken(scoped.payload, input, this.#now());
      await this.#verifyRepository(token, input);
      const current = await this.options.management.getExecutionUserCredential(input);
      input.signal?.throwIfAborted();
      if (!current || current.githubUserId !== parent.githubUserId) throw new GitPublicationError("scope_denied");
      if (current.accessToken === token) throw new GitPublicationError("scope_denied");
      if (current.credentialGeneration !== parent.credentialGeneration || current.accessToken !== parent.accessToken)
        return null;
      if (expiresAt.getTime() <= this.#now() + 5_000) throw new GitPublicationError("scope_denied");
      retained = true;
      return { token, expiresAt };
    } finally {
      if (!retained && candidate && candidate !== parent.accessToken) await this.#discard(candidate, input);
    }
  }

  async #scope(input: GitHubUserTokenInput, repositoryId: number, parent: GitHubExecutionUserCredential) {
    try {
      return {
        payload: await this.options.api.createScopedUserToken({
          accessToken: parent.accessToken,
          target: input.fullName.split("/")[0] as string,
          repositoryId,
          permissions: input.permissions,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      };
    } catch (error) {
      // Only a definite credential rejection with proven concurrent rotation can be re-derived.
      // No repository write has been sent, and unknown mint/network outcomes are never retried.
      if (error instanceof GitHubApiClientError && (error.status === 401 || error.status === 404)) {
        const current = await this.options.management.getExecutionUserCredential(input);
        if (
          current?.githubUserId === parent.githubUserId &&
          current.credentialGeneration !== parent.credentialGeneration
        )
          return null;
      }
      throw error;
    }
  }

  async revoke(token: string): Promise<void> {
    await this.options.api.revokeUserToken(token);
  }

  async #verifyRepository(token: string, input: GitHubUserTokenInput): Promise<void> {
    const page = await this.options.api.listInstallationRepositories({
      accessToken: token,
      installationId: input.installationId,
      page: 1,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const repository = page.repositories[0];
    if (
      page.totalCount !== 1 ||
      page.repositories.length !== 1 ||
      !repository ||
      repository.repositoryId !== input.repositoryId ||
      repository.fullName.toLowerCase() !== input.fullName.toLowerCase()
    )
      throw new GitPublicationError("scope_denied");
  }

  async #discard(token: string, input: GitHubUserTokenInput): Promise<void> {
    try {
      // Read the Account's current parent without the stale execution fence: OAuth replacement
      // can move to another connection/authorization while a scoped-token response is in flight.
      if (await this.options.management.isCurrentUserCredential(input.accountId, token)) return;
      await this.revoke(token);
    } catch {
      this.options.onRevokeFailure?.();
    }
  }

  #now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }
}
