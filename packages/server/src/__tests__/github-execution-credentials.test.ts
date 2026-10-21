import { describe, expect, it, vi } from "vitest";
import { GitHubExecutionCredentials } from "../services/github-proxy/execution-credentials.js";

const input = { accountId: "account", connectionId: "connection", authorizationRevision: "github:7" };
const parent = {
  accessToken: "gho_parent",
  githubUserId: "42",
  accessExpiresAt: new Date(Date.now() + 3600000),
  credentialGeneration: 2n,
};
describe("OAuth execution credential resources", () => {
  it("releases locally without revoking the reusable parent", async () => {
    const management = { getExecutionUserCredential: vi.fn(async () => parent), revoke: vi.fn() };
    const credentials = new GitHubExecutionCredentials(management);
    const first = await credentials.acquire("execution", input);
    expect(first.token).toBe(parent.accessToken);
    await first.release();
    await first.release();
    const second = await credentials.acquire("execution", input);
    expect(second.token).toBe(parent.accessToken);
    await credentials.closeExecution("execution");
    await credentials.close();
    expect(management.revoke).not.toHaveBeenCalled();
    await expect(credentials.acquire("other", input)).rejects.toMatchObject({ code: "scope_denied" });
  });
  it("bounds concurrent requests and executions and frees reservations after failure", async () => {
    const management = { getExecutionUserCredential: vi.fn(async () => parent) };
    const credentials = new GitHubExecutionCredentials(management);
    const leases = await Promise.all(Array.from({ length: 8 }, () => credentials.acquire("execution", input)));
    await expect(credentials.acquire("execution", input)).rejects.toMatchObject({ code: "resource_limit" });
    await leases[0]?.release();
    await credentials.acquire("execution", input);
    await credentials.closeExecution("execution");
    await Promise.all(Array.from({ length: 256 }, (_, i) => credentials.acquire(String(i), input)));
    await expect(credentials.acquire("overflow", input)).rejects.toMatchObject({ code: "resource_limit" });
    await credentials.closeExecution("0");
    await credentials.acquire("replacement", input);
    await credentials.close();
  });
  it("does not expose a credential returned after cancellation", async () => {
    let resolve!: (value: typeof parent) => void;
    const management = {
      getExecutionUserCredential: vi.fn(
        () =>
          new Promise<typeof parent>((r) => {
            resolve = r;
          }),
      ),
    };
    const credentials = new GitHubExecutionCredentials(management);
    const controller = new AbortController();
    const result = credentials.acquire("execution", { ...input, signal: controller.signal });
    controller.abort();
    resolve(parent);
    await expect(result).rejects.toMatchObject({ code: "scope_denied" });
    await credentials.close();
  });
  it("fails closed for stale or unavailable credentials", async () => {
    const credentials = new GitHubExecutionCredentials({ getExecutionUserCredential: async () => null });
    await expect(credentials.acquire("execution", input)).rejects.toMatchObject({ code: "scope_denied" });
    await credentials.close();
  });
});
