import { vi } from "vitest";
import { users } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import type {
  GitHubApiClient,
  GitHubRepository,
  GitHubUserTokenMaterial,
} from "../../services/github/github-api-client.js";
import type { GitHubCredentialCipher } from "../../services/github-credential-material.js";
import { GitHubCredentialCipher as RealGitHubCredentialCipher } from "../../services/github-credential-material.js";
import type { UnitDatabase } from "./unit-database.js";

export const GITHUB_TEST_CLIENT_ID = "Ov23testclient";
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
  exchangeCodeForUserToken: ReturnType<typeof vi.fn<GitHubApiClient["exchangeCodeForUserToken"]>>;
  refreshUserToken: ReturnType<typeof vi.fn<GitHubApiClient["refreshUserToken"]>>;
  getAuthenticatedUser: ReturnType<typeof vi.fn<GitHubApiClient["getAuthenticatedUser"]>>;
  validateOAuthToken: ReturnType<typeof vi.fn<GitHubApiClient["validateOAuthToken"]>>;
  listUserRepositories: ReturnType<typeof vi.fn<GitHubApiClient["listUserRepositories"]>>;
  getRepository: ReturnType<typeof vi.fn<GitHubApiClient["getRepository"]>>;
  asClient(): GitHubApiClient;
}

export function stubGitHubApi(): GitHubApiStub {
  const stub: GitHubApiStub = {
    exchangeCodeForUserToken: vi.fn(),
    refreshUserToken: vi.fn(),
    getAuthenticatedUser: vi.fn(async () => ({ id: "42", login: "octocat" })),
    validateOAuthToken: vi.fn(async (input) => stub.getAuthenticatedUser(input)),
    listUserRepositories: vi.fn(),
    getRepository: vi.fn(),
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
