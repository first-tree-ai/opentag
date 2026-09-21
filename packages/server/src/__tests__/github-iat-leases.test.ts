import { expect, it, vi } from "vitest";
import { GitHubIatLeases } from "../services/github-proxy/iat-leases.js";

const input = { installationId: "1", repositoryId: "2", permissions: { contents: "read" as const } };
const token = { token: "fixture-installation-token", expiresAt: new Date(Date.now() + 3600000) };

it("shutdown waits for revocation already started by an execution-close listener", async () => {
  const gate = deferred<void>();
  const revoke = vi.fn(() => gate.promise);
  const leases = new GitHubIatLeases({ mint: async () => token, revoke });
  await leases.acquire("execution", input);
  const closingExecution = leases.revokeExecution("execution");
  let stopped = false;
  const stopping = leases.close().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(revoke).toHaveBeenCalledWith(token.token);
  gate.resolve();
  await Promise.all([closingExecution, stopping]);
  expect(stopped).toBe(true);
});

it("shutdown waits for an in-flight mint and its subsequent revoke", async () => {
  const mint = deferred<typeof token>();
  const revoke = deferred<void>();
  const client = { mint: () => mint.promise, revoke: vi.fn(() => revoke.promise) };
  const leases = new GitHubIatLeases(client);
  const acquiring = leases.acquire("execution", input);
  const rejected = expect(acquiring).rejects.toMatchObject({ code: "scope_denied" });
  let stopped = false;
  const stopping = leases.close().then(() => {
    stopped = true;
  });
  mint.resolve(token);
  await vi.waitFor(() => expect(client.revoke).toHaveBeenCalledWith(token.token));
  expect(stopped).toBe(false);
  revoke.resolve();
  await Promise.all([rejected, stopping]);
  expect(stopped).toBe(true);
});

it("reports revocation failures through a controlled diagnostic without retaining token material", async () => {
  const diagnostic = vi.fn();
  const revoke = vi.fn(async () => {
    throw new Error(token.token);
  });
  const leases = new GitHubIatLeases({ mint: async () => token, revoke }, diagnostic);
  const lease = await leases.acquire("execution", input);
  await lease.release();
  await leases.close();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith();
  expect(revoke).toHaveBeenCalledTimes(1);
});

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
