import { describe, expect, it } from "vitest";
import { GitHubApiClientError } from "../services/github/github-api-client.js";
import type { GitHubUserTokenInput } from "../services/github/user-token-types.js";
import {
  USER_TOKEN_INPUT as input,
  USER_TOKEN_NOW as now,
  scopedRepositoryPage,
  scopedUserPayload,
  userTokenFixture,
} from "./support/github-user-token-fixture.js";

describe("GitHub user identity credentials", () => {
  it("derives one repository user token with App Basic auth and verifies the actual scope", async () => {
    const f = userTokenFixture();
    expect(await f.client.mint(input)).toEqual({
      token: "ghu_scoped_a",
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    expect(f.calls[0]).toMatchObject({
      path: "/applications/Iv1.client/token/scoped",
      method: "POST",
      body: {
        access_token: "ghu_parent_a",
        target: "owner",
        repository_ids: [123],
        permissions: { contents: "read" },
      },
    });
    expect(f.calls[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("Iv1.client:client-secret").toString("base64")}`,
    );
    expect(f.calls[1]).toMatchObject({ path: "/user/installations/456/repositories", method: "GET" });
    expect(f.calls[1]?.headers.get("authorization")).toBe("Bearer ghu_scoped_a");
    expect(f.management.getExecutionUserCredential).toHaveBeenCalledWith(input);
    await f.client.revoke("ghu_scoped_a");
    expect(f.calls[2]).toMatchObject({
      method: "DELETE",
      path: "/applications/Iv1.client/token",
      body: { access_token: "ghu_scoped_a" },
    });
    expect(f.calls.some((call) => call.path.includes("/grant") || call.path.includes("/access_tokens"))).toBe(false);
  });

  it.each([
    { repositoryId: "9007199254740992" },
    { repositoryId: "1/2" },
    { fullName: "owner/../other" },
    { installationId: "../other" },
    { authorizationRevision: "github:wrong" },
    { permissions: { contents: "read", administration: "write" } },
    { permissions: { contents: "read", checks: "write" } },
    { permissions: { contents: "admin" } },
    { permissions: { contents: "toString" } },
  ])("rejects invalid derived requests before sending any credential: %j", async (changes) => {
    const f = userTokenFixture();
    await expect(f.client.mint({ ...input, ...changes } as GitHubUserTokenInput)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { accessToken: "ghu_parent_a", githubUserId: "42", credentialGeneration: 3n, accessExpiresAt: new Date(0) },
  ])("does not mint with a missing, disconnected or expired parent", async (parent) => {
    const f = userTokenFixture();
    f.setParent(parent);
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { token: "ghu_parent_a" },
    { token: "ghu_parent_a", user: null },
    { token: "ghu_bad\r\ntoken" },
    { token: "" },
    { token: null },
    { token: "x".repeat(4097) },
  ])("never uses or revokes the parent or malformed token material: %j", async (changes) => {
    const f = userTokenFixture();
    f.setPayload({ ...scopedUserPayload(), ...changes });
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    { token: "ghs_bot_token" },
    { token: "future_token_format" },
    { user: { id: 99, type: "User" } },
    { user: { id: 42, type: "Bot" } },
    { app: { client_id: "another-app" } },
    { user: null },
    { app: null },
  ])("rejects failed identity attestation but cleans the returned token: %j", async (changes) => {
    const f = userTokenFixture();
    const payload = { ...scopedUserPayload(), ...changes };
    f.setPayload(payload);
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toMatchObject({ method: "DELETE", body: { access_token: payload.token } });
    expect(f.calls.some((call) => call.path.startsWith("/user/installations"))).toBe(false);
  });

  it.each([
    { expires_at: "invalid" },
    { expires_at: now.toISOString() },
    { expires_at: new Date(now.getTime() + 9 * 3_600_000).toISOString() },
    { installation: null },
    { installation: { repository_selection: null, permissions: { contents: "read" }, account: { login: "owner" } } },
    { installation: { repository_selection: "selected", permissions: null, account: { login: "owner" } } },
    { installation: { repository_selection: "selected", permissions: { contents: "read" }, account: null } },
    {
      installation: {
        repository_selection: "selected",
        permissions: { contents: "write" },
        account: { login: "owner" },
      },
    },
    {
      installation: {
        repository_selection: "selected",
        permissions: { contents: "read", administration: "write" },
        account: { login: "owner" },
      },
    },
    { installation: { repository_selection: "selected", permissions: {}, account: { login: "owner" } } },
    {
      installation: {
        repository_selection: "selected",
        permissions: { contents: "read" },
        account: { login: "foreign" },
      },
    },
  ])("cleans only the attested child on scope or expiry rejection: %j", async (changes) => {
    const f = userTokenFixture();
    f.setPayload({ ...scopedUserPayload(), ...changes });
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", body: { access_token: "ghu_scoped_a" } });
  });

  it.each([null, undefined])("rejects an unbounded child lifetime explicitly and cleans it: %s", async (expiry) => {
    const f = userTokenFixture();
    f.setPayload({ ...scopedUserPayload(), expires_at: expiry });
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "GITHUB_TOKEN_LIFETIME_UNSUPPORTED" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", body: { access_token: "ghu_scoped_a" } });
  });

  it.each(["all", "selected"])("proves exact repository scope independently of the %s label", async (selection) => {
    const f = userTokenFixture();
    const payload = scopedUserPayload();
    payload.installation.repository_selection = selection;
    f.setPayload(payload);
    await expect(f.client.mint(input)).resolves.toMatchObject({ token: payload.token });
    expect(f.calls[1]?.path).toBe("/user/installations/456/repositories");
    f.setRepositories({ total_count: 2, repositories: scopedRepositoryPage().repositories });
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", body: { access_token: payload.token } });
  });

  it.each([
    { total_count: 2, repositories: scopedRepositoryPage().repositories },
    { total_count: 1, repositories: [] },
    { total_count: 1, repositories: [{ ...scopedRepositoryPage().repositories[0], id: 321 }] },
    { total_count: 1, repositories: [{ ...scopedRepositoryPage().repositories[0], full_name: "other/repository" }] },
  ])("requires proof of exactly the actual repository: %j", async (page) => {
    const f = userTokenFixture();
    f.setRepositories(page);
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls.at(-1)?.body).toEqual({ access_token: "ghu_scoped_a" });
  });

  it("rechecks a disconnect while minting and revokes the child before use", async () => {
    const f = userTokenFixture();
    f.management.getExecutionUserCredential
      .mockResolvedValueOnce({
        accessToken: "ghu_parent_a",
        githubUserId: "42",
        accessExpiresAt: new Date(now.getTime() + 8 * 3_600_000),
        credentialGeneration: 3n,
      })
      .mockResolvedValueOnce(null);
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls.at(-1)?.body).toEqual({ access_token: "ghu_scoped_a" });
  });

  it("never cleans up a response token that is the newly refreshed parent", async () => {
    const f = userTokenFixture();
    f.setPayload(scopedUserPayload("ghu_parent_b"));
    const current = {
      accessToken: "ghu_parent_b",
      githubUserId: "42",
      credentialGeneration: 4n,
      accessExpiresAt: new Date(now.getTime() + 8 * 3_600_000),
    };
    f.setParent(current);
    f.management.getExecutionUserCredential
      .mockResolvedValueOnce({ ...current, accessToken: "ghu_parent_a", credentialGeneration: 3n })
      .mockResolvedValue(current);
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it.each([false, true])("protects a replaced parent even when identity attestation fails (%s)", async (wrongUser) => {
    const f = userTokenFixture();
    f.setPayload(scopedUserPayload("ghu_reconnected_parent", wrongUser ? "99" : "42"));
    f.management.getExecutionUserCredential
      .mockResolvedValueOnce({
        accessToken: "ghu_parent_a",
        githubUserId: "42",
        credentialGeneration: 3n,
        accessExpiresAt: new Date(now.getTime() + 8 * 3_600_000),
      })
      .mockResolvedValue(null);
    f.management.isCurrentUserCredential.mockImplementation(
      async (accountId, token) => accountId === input.accountId && token === "ghu_reconnected_parent",
    );
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.management.isCurrentUserCredential).toHaveBeenCalledWith(input.accountId, "ghu_reconnected_parent");
    expect(f.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("checks the child's own bounded expiry independently of the parent's refresh schedule", async () => {
    const f = userTokenFixture();
    f.setParent({
      accessToken: "ghu_parent_a",
      githubUserId: "42",
      credentialGeneration: 3n,
      accessExpiresAt: new Date(now.getTime() + 20 * 60_000),
    });
    await expect(f.client.mint(input)).resolves.toMatchObject({
      token: "ghu_scoped_a",
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
  });

  it("reacquires once after routine parent rotation before any repository operation", async () => {
    const f = userTokenFixture();
    const fetchImpl = f.fetch.getMockImplementation();
    let mints = 0;
    f.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/scoped") && ++mints === 2) return Response.json(scopedUserPayload("ghu_scoped_b"));
      if (!fetchImpl) throw new Error("Fixture fetch missing");
      return fetchImpl(url, init);
    });
    const current = {
      accessToken: "ghu_parent_b",
      githubUserId: "42",
      accessExpiresAt: new Date(now.getTime() + 8 * 3_600_000),
      credentialGeneration: 4n,
    };
    f.management.getExecutionUserCredential
      .mockResolvedValueOnce({ ...current, accessToken: "ghu_parent_a", credentialGeneration: 3n })
      .mockResolvedValue(current);
    await expect(f.client.mint(input)).resolves.toMatchObject({ token: "ghu_scoped_b" });
    expect(
      f.fetch.mock.calls
        .filter(([url]) => String(url).endsWith("/scoped"))
        .map(([, init]) => JSON.parse(String(init?.body)).access_token),
    ).toEqual(["ghu_parent_a", "ghu_parent_b"]);
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("does not replay on network failure or retain secrets in errors", async () => {
    const f = userTokenFixture();
    f.fetch.mockRejectedValueOnce(new Error("ghu_parent_a client-secret"));
    const error = await f.client.mint(input).catch((error) => error);
    expect(error).toBeInstanceOf(GitHubApiClientError);
    expect(String(error)).not.toMatch(/ghu_parent_a|client-secret/);
    expect(error.cause).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 404])(
    "derives again only when a rejected old parent was concurrently refreshed (%s)",
    async (status) => {
      const f = userTokenFixture();
      f.fetch.mockImplementationOnce(async () => {
        f.setParent({
          accessToken: "ghu_parent_b",
          githubUserId: "42",
          credentialGeneration: 4n,
          accessExpiresAt: new Date(now.getTime() + 8 * 3_600_000),
        });
        return new Response(null, { status });
      });
      await expect(f.client.mint(input)).resolves.toMatchObject({ token: "ghu_scoped_a" });
      expect(
        f.fetch.mock.calls
          .filter(([url]) => String(url).endsWith("/scoped"))
          .map(([, init]) => JSON.parse(String(init?.body)).access_token),
      ).toEqual(["ghu_parent_a", "ghu_parent_b"]);
    },
  );

  it("does not retry a rejected parent after a user/authorization change", async () => {
    const f = userTokenFixture();
    f.fetch.mockImplementationOnce(async () => {
      f.setParent(null);
      return new Response(null, { status: 404 });
    });
    await expect(f.client.mint(input)).rejects.toBeInstanceOf(GitHubApiClientError);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([201, 302, 401, 403, 429, 503])(
    "rejects an unexpected mint status %s without retry or fallback",
    async (status) => {
      const f = userTokenFixture();
      f.fetch.mockResolvedValueOnce(new Response("secret-upstream-body", { status }));
      const error = await f.client.mint(input).catch((error) => error);
      expect(error).toBeInstanceOf(GitHubApiClientError);
      expect(String(error)).not.toContain("secret-upstream-body");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves the scope rejection when child cleanup fails", async () => {
    const f = userTokenFixture();
    f.setPayload({ ...scopedUserPayload(), expires_at: "invalid" });
    f.api.revokeUserToken = async () => {
      throw new Error("sensitive");
    };
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.diagnostic).toHaveBeenCalledOnce();
  });

  it("preserves identity rejection and reports cleanup failure without exposing the candidate", async () => {
    const f = userTokenFixture();
    f.setPayload({ ...scopedUserPayload(), user: null });
    f.api.revokeUserToken = async () => {
      throw new Error("ghu_scoped_a");
    };
    const error = await f.client.mint(input).catch((error) => error);
    expect(error).toMatchObject({ code: "scope_denied" });
    expect(String(error)).not.toContain("ghu_scoped_a");
    expect(f.diagnostic).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not revoke a candidate when the fresh parent lookup is unavailable", async () => {
    const f = userTokenFixture();
    f.setPayload({ ...scopedUserPayload(), user: null });
    f.management.isCurrentUserCredential.mockRejectedValue(new Error("database unavailable"));
    await expect(f.client.mint(input)).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.calls).toHaveLength(1);
    expect(f.diagnostic).toHaveBeenCalledExactlyOnceWith();
  });
});
