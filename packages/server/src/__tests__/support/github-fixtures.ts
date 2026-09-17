import { vi } from "vitest";
import { users } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import type {
  GitHubApiClient,
  GitHubInstallationRepositoriesPage,
  GitHubUserInstallationsPage,
  GitHubUserTokenMaterial,
} from "../../services/github/github-api-client.js";
import type { GitHubCredentialCipher } from "../../services/github-credential-material.js";
import { GitHubCredentialCipher as RealGitHubCredentialCipher } from "../../services/github-credential-material.js";
import type { UnitDatabase } from "./unit-database.js";

export const GITHUB_TEST_APP_ID = "871235";
export const GITHUB_TEST_HOST = "github.com";

export function testCredentialCipher(): GitHubCredentialCipher {
  return new RealGitHubCredentialCipher(new ApplicationCipher(Buffer.alloc(32, 7)));
}

export async function createAccount(unit: UnitDatabase, email = `owner-${crypto.randomUUID()}@example.com`) {
  const [account] = await unit.database.insert(users).values({ displayName: "Owner", email }).returning();
  if (!account) throw new Error("Missing test Account");
  return account;
}

export interface GitHubApiStub {
  exchangeCodeForUserToken: ReturnType<typeof vi.fn>;
  refreshUserToken: ReturnType<typeof vi.fn>;
  getAuthenticatedUser: ReturnType<typeof vi.fn>;
  listUserInstallations: ReturnType<typeof vi.fn>;
  listInstallationRepositories: ReturnType<typeof vi.fn>;
  asClient(): GitHubApiClient;
}

export function stubGitHubApi(): GitHubApiStub {
  const stub: GitHubApiStub = {
    exchangeCodeForUserToken: vi.fn(),
    refreshUserToken: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    listUserInstallations: vi.fn(),
    listInstallationRepositories: vi.fn(),
    asClient() {
      return stub as unknown as GitHubApiClient;
    },
  };
  return stub;
}

export function tokenMaterial(overrides: Partial<GitHubUserTokenMaterial> = {}): GitHubUserTokenMaterial {
  return {
    accessToken: "ghu_access",
    refreshToken: "ghr_refresh",
    accessExpiresAt: new Date("2026-09-16T08:00:00.000Z"),
    refreshExpiresAt: new Date("2027-03-16T00:00:00.000Z"),
    ...overrides,
  };
}

export function installationsPage(
  installations: GitHubUserInstallationsPage["installations"],
  totalCount = installations.length,
): GitHubUserInstallationsPage {
  return { totalCount, installations };
}

export function installation(overrides: Partial<GitHubUserInstallationsPage["installations"][number]> = {}) {
  return {
    installationId: "55123456",
    appId: GITHUB_TEST_APP_ID,
    accountLogin: "octocat",
    accountType: "Organization" as const,
    repositorySelection: "selected" as const,
    permissions: { contents: "write" as const, pull_requests: "write" as const, metadata: "read" as const },
    suspended: false,
    ...overrides,
  };
}

export function repositoriesPage(
  repositories: GitHubInstallationRepositoriesPage["repositories"],
  totalCount = repositories.length,
): GitHubInstallationRepositoriesPage {
  return { totalCount, repositorySelection: "selected", repositories };
}

export function repository(overrides: Partial<GitHubInstallationRepositoriesPage["repositories"][number]> = {}) {
  return {
    repositoryId: "987654321",
    fullName: "octocat/hello-world",
    private: true,
    defaultBranch: "main",
    permissions: { admin: false, pull: true, push: true },
    ...overrides,
  };
}
