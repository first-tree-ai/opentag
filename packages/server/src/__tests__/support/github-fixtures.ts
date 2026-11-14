import { vi } from "vitest";
import type { GitHubApiClient, GitHubRepository } from "../../services/github/github-api-client.js";

interface GitHubApiStub {
  getAuthenticatedUser: ReturnType<typeof vi.fn<GitHubApiClient["getAuthenticatedUser"]>>;
  getRepository: ReturnType<typeof vi.fn<GitHubApiClient["getRepository"]>>;
  asClient(): GitHubApiClient;
}

export function stubGitHubApi(): GitHubApiStub {
  const stub: GitHubApiStub = {
    getAuthenticatedUser: vi.fn(async () => ({ id: "42", login: "octocat" })),
    getRepository: vi.fn(),
    asClient() {
      return stub as unknown as GitHubApiClient;
    },
  };
  return stub;
}

export function repository(overrides: Partial<GitHubRepository[][number]> = {}) {
  return {
    repositoryId: "987654321",
    fullName: "octocat/hello-world",
    private: true,
    defaultBranch: "main",
    permissions: { admin: false, pull: true, push: true },
    ...overrides,
  };
}
