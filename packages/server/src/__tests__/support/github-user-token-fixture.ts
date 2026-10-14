import { type Mock, vi } from "vitest";
import { GitHubApiClient } from "../../services/github/github-api-client.js";
import { GitHubUserTokenClient } from "../../services/github/user-token-client.js";
import type { GitHubExecutionUserCredential, GitHubUserTokenInput } from "../../services/github/user-token-types.js";

export const USER_TOKEN_NOW = new Date("2026-10-14T00:00:00Z");
export const USER_TOKEN_INPUT: GitHubUserTokenInput = {
  accountId: "account-a",
  connectionId: "connection-a",
  authorizationRevision: "github:7",
  installationId: "456",
  repositoryId: "123",
  fullName: "owner/repository",
  permissions: { contents: "read" },
};
export function scopedUserPayload(
  token = "ghu_scoped_a",
  userId = "42",
  permissions: unknown = { contents: "read", metadata: "read" },
) {
  return {
    token,
    expires_at: new Date(USER_TOKEN_NOW.getTime() + 3_600_000).toISOString(),
    user: { id: Number(userId), type: "User", login: `user-${userId}` },
    app: { client_id: "Iv1.client" },
    installation: { repository_selection: "selected", permissions, account: { login: "owner", type: "Organization" } },
  };
}
export function scopedRepositoryPage() {
  return {
    total_count: 1,
    repositories: [
      {
        id: 123,
        full_name: "owner/repository",
        default_branch: "main",
        private: true,
        permissions: { admin: false, pull: true, push: true },
      },
    ],
  };
}
export interface UserTokenFixture {
  client: GitHubUserTokenClient;
  api: GitHubApiClient;
  fetch: Mock<typeof globalThis.fetch>;
  calls: { path: string; method: string; headers: Headers; body: unknown }[];
  management: {
    isCurrentUserCredential: Mock<(accountId: string, token: string) => Promise<boolean>>;
    getExecutionUserCredential: Mock<
      (
        input: Pick<GitHubUserTokenInput, "accountId" | "connectionId" | "authorizationRevision">,
      ) => Promise<GitHubExecutionUserCredential | null>
    >;
  };
  diagnostic: Mock<() => void>;
  setPayload(value: unknown): void;
  setRepositories(value: unknown): void;
  setParent(value: GitHubExecutionUserCredential | null): void;
}

export function userTokenFixture(): UserTokenFixture {
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  let payload: unknown = scopedUserPayload();
  let repositories: unknown = scopedRepositoryPage();
  let parent: GitHubExecutionUserCredential | null = {
    accessToken: "ghu_parent_a",
    githubUserId: "42",
    accessExpiresAt: new Date(USER_TOKEN_NOW.getTime() + 8 * 3_600_000),
    credentialGeneration: 3n,
  };
  const getExecutionUserCredential = vi.fn(
    async (_input: Pick<GitHubUserTokenInput, "accountId" | "connectionId" | "authorizationRevision">) => parent,
  );
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(path.endsWith("/scoped") ? payload : repositories);
  });
  const api = new GitHubApiClient({
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    redirectUri: "https://opentag.example/callback",
    fetch,
    now: () => USER_TOKEN_NOW,
  });
  const diagnostic = vi.fn();
  const management = {
    getExecutionUserCredential,
    isCurrentUserCredential: vi.fn(async (_accountId: string, token: string) => parent?.accessToken === token),
  };
  const client = new GitHubUserTokenClient({
    api,
    management,
    clientId: "Iv1.client",
    now: () => USER_TOKEN_NOW,
    onRevokeFailure: diagnostic,
  });
  return {
    client,
    api,
    fetch,
    calls,
    management,
    diagnostic,
    setPayload: (value: unknown) => {
      payload = value;
    },
    setRepositories: (value: unknown) => {
      repositories = value;
    },
    setParent: (value: GitHubExecutionUserCredential | null) => {
      parent = value;
    },
  };
}
