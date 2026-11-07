import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import type { GitHubApiClient } from "./github-api-client.js";

export class GitHubRepositoryAdmissionService {
  constructor(private readonly options: { api: GitHubApiClient }) {}

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
