import type { GitHubRepositoryDiscoveryPage } from "@opentag/shared";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import { GITHUB_REPOSITORIES_PER_PAGE, type GitHubApiClient } from "./github-api-client.js";

const MAX_REPOSITORY_PAGES = 100;

export class GitHubRepositoryAdmissionService {
  constructor(private readonly options: { api: GitHubApiClient }) {}

  async discoverRepositories(input: {
    accessToken: string;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<GitHubRepositoryDiscoveryPage> {
    const page = input.cursor === undefined ? 1 : Number(input.cursor);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > MAX_REPOSITORY_PAGES ||
      (input.cursor !== undefined && String(page) !== input.cursor)
    )
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
        400,
        "Invalid repository cursor",
      );
    const repositories = await this.options.api.listUserRepositories({ ...input, page });
    const full = repositories.length === GITHUB_REPOSITORIES_PER_PAGE;
    return {
      repositories: repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        private: repository.private,
        defaultBranch: repository.defaultBranch,
        permissions: {
          pull: repository.permissions.pull || repository.permissions.push || repository.permissions.admin,
          push: repository.permissions.push || repository.permissions.admin,
        },
      })),
      nextCursor: full && page < MAX_REPOSITORY_PAGES ? String(page + 1) : null,
      truncated: full && page === MAX_REPOSITORY_PAGES,
    };
  }

  async resolveRepository(input: {
    accessToken: string;
    fullName: string;
    access: "read" | "write";
    publish?: "direct" | "pull_request";
    signal?: AbortSignal;
  }) {
    const repository = await this.options.api.getRepository(input);
    if (repository.fullName.toLowerCase() !== input.fullName.toLowerCase())
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_REPOSITORY_MISSING,
        403,
        "Repository identity changed",
      );
    const { pull, push, admin } = repository.permissions;
    if (input.access === "write" ? !(push || admin) : !(pull || push || admin))
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT,
        403,
        "The connected user cannot perform this repository operation",
      );
    return {
      repositoryId: repository.repositoryId,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
    };
  }
}
