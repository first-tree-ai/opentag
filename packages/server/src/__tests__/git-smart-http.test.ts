import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import type { GitHubExecutionRepository } from "../services/github-proxy/execution-policy.js";
import { GitPublicationError } from "../services/github-proxy/git-packets.js";
import { handleGitSmartHttp } from "../services/github-proxy/git-smart-http.js";

/**
 * `handleGitSmartHttp` is the native-Git entry point of the GitHub provider adapter. Everything it
 * talks to outside this file — the IAT leases, the read transport, the publication guard, and the
 * repository metadata call — is injected, so the suite fakes those four seams and never opens a
 * socket. The real end-to-end pack exchange already lives in `github-read-transport.test.ts`.
 */

const SESSION_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const IAT = "ghs_test-installation-token";
const METADATA = { id: 123, node_id: "R_test", full_name: "owner/repository", default_branch: "main" };

function repository(overrides: Partial<GitHubExecutionRepository> = {}): GitHubExecutionRepository {
  return {
    installationId: "456",
    repositoryId: "123",
    fullName: "owner/repository",
    scopes: [{ agentId: randomUUID(), role: "code", access: "write", publish: "pull_request" }],
    protectedTreeRefs: ["refs/heads/master"],
    ...overrides,
  };
}

function authorization(overrides: Partial<RuntimeProxyAuthorization> = {}): RuntimeProxyAuthorization {
  return {
    executionId: "execution",
    provider: "github",
    bindingId: "binding",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "github:1",
    credentialGeneration: "2",
    sessionId: SESSION_ID,
    accountId: randomUUID(),
    agentId: randomUUID(),
    cli: { provider: "github", connectionId: "binding", repositories: [] },
    resolveMaterial: async () => {
      throw new Error("No user material may reach execution");
    },
    recheck: vi.fn(async () => undefined),
    ...overrides,
  };
}

interface Harness {
  options: Parameters<typeof handleGitSmartHttp>[0];
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  receive: ReturnType<typeof vi.fn>;
  readHandle: ReturnType<typeof vi.fn>;
  metadata: ReturnType<typeof vi.fn>;
  repositories: GitHubExecutionRepository[];
}

function harness(
  input: {
    repositories?: GitHubExecutionRepository[];
    readResponse?: { status?: number; headers?: Record<string, string>; chunks: Uint8Array[] };
    receiveResult?: Uint8Array;
  } = {},
): Harness {
  const release = vi.fn(async () => undefined);
  const acquire = vi.fn(async () => ({ token: IAT, release }));
  const receive = vi.fn(async () => input.receiveResult ?? Buffer.from("receive-result"));
  const readHandle = vi.fn(async () => ({
    status: input.readResponse?.status ?? 200,
    headers: input.readResponse?.headers ?? { "content-type": "application/x-git-upload-pack-advertisement" },
    body: (async function* () {
      for (const chunk of input.readResponse?.chunks ?? [Buffer.from("read-body")]) yield chunk;
    })(),
  }));
  const metadata = vi.fn(async () => METADATA);
  const repositories = input.repositories ?? [repository()];
  return {
    acquire,
    metadata,
    options: {
      leases: { acquire } as unknown as Parameters<typeof handleGitSmartHttp>[0]["leases"],
      reads: { handle: readHandle } as unknown as Parameters<typeof handleGitSmartHttp>[0]["reads"],
      publication: { receive } as unknown as Parameters<typeof handleGitSmartHttp>[0]["publication"],
      metadata,
    },
    readHandle,
    receive,
    release,
    repositories,
  };
}

function request(input: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {}) {
  return {
    executionId: "execution",
    sessionId: SESSION_ID,
    provider: "github",
    bindingId: "binding",
    method: input.method ?? "GET",
    path: "/owner/repository.git/info/refs?service=git-upload-pack",
    headers: input.headers ?? { "git-protocol": "version=2" },
    body: (async function* () {
      if (input.body) yield input.body;
    })(),
    capability: "trusted-runner-capability",
    capabilityTtlSeconds: 60,
    signal: new AbortController().signal,
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

const URL_FOR = (path: string) => new URL(`https://github.com${path}`);

describe("handleGitSmartHttp request parsing", () => {
  it("advertises upload-pack for a code grant with the repository default branch", async () => {
    const fake = harness();
    const response = await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    expect(response.status).toBe(200);
    expect(await collect(response.body)).toBe("read-body");
    expect(fake.readHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "123",
        service: "git-upload-pack",
        advertise: true,
        protocol: "version=2",
        defaultRef: "refs/heads/main",
        allowedRefs: undefined,
        body: expect.anything(),
        signal: expect.anything(),
      }),
    );
    expect(fake.acquire).toHaveBeenCalledWith(
      "execution",
      expect.objectContaining({
        installationId: "456",
        repositoryId: "123",
        permissions: { contents: "read" },
      }),
    );
    // A read releases the lease as soon as the body is drained, and the token never leaks.
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("matches the repository full name case-insensitively", async () => {
    const fake = harness();
    await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/OWNER/Repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    expect(fake.readHandle).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first scope branch for a Tree-only grant", async () => {
    const treeOnly = repository({
      scopes: [
        {
          agentId: randomUUID(),
          role: "context_tree",
          access: "read",
          branch: "refs/heads/tree-topic",
        },
      ],
    });
    const fake = harness({ repositories: [treeOnly] });
    await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    expect(fake.readHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultRef: "refs/heads/tree-topic",
        allowedRefs: ["refs/heads/tree-topic"],
      }),
    );
  });

  it("falls back to master when a Tree-only grant carries no branch at all", async () => {
    const treeOnly = repository({
      scopes: [{ agentId: randomUUID(), role: "context_tree", access: "write", publish: "pull_request" }],
    });
    const fake = harness({ repositories: [treeOnly] });
    await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    expect(fake.readHandle).toHaveBeenCalledWith(expect.objectContaining({ defaultRef: "refs/heads/master" }));
  });

  it("advertises receive-pack with a write permission on a code write grant", async () => {
    const fake = harness();
    const response = await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-receive-pack"),
      fake.repositories,
    );
    expect(response.status).toBe(200);
    expect(fake.acquire).toHaveBeenCalledWith(
      "execution",
      expect.objectContaining({ permissions: { contents: "read" } }),
    );
    expect(fake.readHandle).toHaveBeenCalledWith(
      expect.objectContaining({ service: "git-receive-pack", advertise: true }),
    );
    // An advertisement is a read: it never goes through the publication guard.
    expect(fake.receive).not.toHaveBeenCalled();
  });
});

describe("handleGitSmartHttp publication", () => {
  it("routes a receive-pack POST through the publication guard and answers the result body", async () => {
    const fake = harness({ receiveResult: Buffer.from("000eunpack ok\n0000") });
    const response = await handleGitSmartHttp(
      fake.options,
      request({ method: "POST", headers: {}, body: Buffer.from("pack") }),
      authorization(),
      URL_FOR("/owner/repository.git/git-receive-pack"),
      fake.repositories,
    );
    expect(response).toEqual({
      status: 200,
      headers: {
        "content-type": "application/x-git-receive-pack-result",
        "cache-control": "no-store",
      },
      body: expect.anything(),
    });
    expect(await collect(response.body)).toBe("000eunpack ok\n0000");
    expect(fake.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "123",
        scopes: [{ role: "code", refPrefix: `refs/heads/opentag/${SESSION_ID}/code/` }],
        protectedTreeRefs: ["refs/heads/master"],
        remote: expect.anything(),
        revalidate: expect.any(Function),
      }),
    );
    expect(fake.acquire).toHaveBeenCalledWith(
      "execution",
      expect.objectContaining({ permissions: { contents: "write" } }),
    );
    // The write path reads no refs and releases the lease before returning.
    expect(fake.readHandle).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("denies a receive-pack POST from a read-only grant before acquiring any lease", async () => {
    const readonly = repository({
      scopes: [{ agentId: randomUUID(), role: "code", access: "read" }],
    });
    const fake = harness({ repositories: [readonly] });
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "POST", headers: {} }),
        authorization(),
        URL_FOR("/owner/repository.git/git-receive-pack"),
        fake.repositories,
      ),
    ).rejects.toThrow(/scope_denied/);
    expect(fake.acquire).not.toHaveBeenCalled();
    expect(fake.receive).not.toHaveBeenCalled();
  });

  it("denies the receive-pack advertisement too when the grant exposes no publication scope", async () => {
    const readonly = repository({ scopes: [{ agentId: randomUUID(), role: "code", access: "read" }] });
    const fake = harness({ repositories: [readonly] });
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "GET" }),
        authorization(),
        URL_FOR("/owner/repository.git/info/refs?service=git-receive-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("propagates a publication failure and still releases the lease", async () => {
    const fake = harness();
    fake.receive.mockRejectedValue(new GitPublicationError("remote_conflict"));
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "POST", headers: {} }),
        authorization(),
        URL_FOR("/owner/repository.git/git-receive-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "remote_conflict" });
    expect(fake.release).toHaveBeenCalledTimes(1);
  });
});

describe("handleGitSmartHttp rejections", () => {
  it.each([
    ["an unknown path shape", "/owner/repository/other"],
    ["a missing .git suffix", "/owner/repository/info/refs?service=git-upload-pack"],
    ["an unknown service", "/owner/repository.git/git-archive-pack"],
    ["an info/refs advertisement with no service parameter", "/owner/repository.git/info/refs"],
    ["a nested repository path", "/owner/nested/repository.git/info/refs?service=git-upload-pack"],
  ])("rejects %s without acquiring a lease", async (_label, path) => {
    const fake = harness();
    await expect(
      handleGitSmartHttp(fake.options, request({ method: "GET" }), authorization(), URL_FOR(path), fake.repositories),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("rejects a repository outside the execution grant for both services", async () => {
    const fake = harness();
    for (const path of [
      "/else/repository.git/info/refs?service=git-upload-pack",
      "/else/repository.git/git-receive-pack",
    ]) {
      await expect(
        handleGitSmartHttp(fake.options, request({ method: "GET" }), authorization(), URL_FOR(path), fake.repositories),
      ).rejects.toMatchObject({ code: "scope_denied" });
    }
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("rejects a service the advertisement does not authorize", async () => {
    const fake = harness();
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "GET" }),
        authorization(),
        URL_FOR("/owner/repository.git/info/refs?service=git-archive"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // The regex only admits the two real services, so this is the repository lookup failing first.
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("rejects a POST advertisement and a GET service execution", async () => {
    const fake = harness();
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "POST", headers: {} }),
        authorization(),
        URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "GET" }),
        authorization(),
        URL_FOR("/owner/repository.git/git-upload-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("rejects a service execution that carries a query string", async () => {
    const fake = harness();
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "POST", headers: {} }),
        authorization(),
        URL_FOR("/owner/repository.git/git-upload-pack?service=git-upload-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("rejects an advertisement whose service parameter is padded or reordered", async () => {
    const fake = harness();
    for (const search of ["?service=git-upload-pack&extra=1", "?extra=1&service=git-upload-pack"]) {
      await expect(
        handleGitSmartHttp(
          fake.options,
          request({ method: "GET" }),
          authorization(),
          URL_FOR(`/owner/repository.git/info/refs${search}`),
          fake.repositories,
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("rejects an advertisement whose repository is not granted, for both services", async () => {
    const fake = harness();
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      await expect(
        handleGitSmartHttp(
          fake.options,
          request({ method: "GET" }),
          authorization(),
          URL_FOR(`/else/repository.git/info/refs?service=${service}`),
          fake.repositories,
        ),
      ).rejects.toMatchObject({ code: "scope_denied" });
    }
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("surfaces a stale authorization recheck before the metadata call", async () => {
    const fake = harness();
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "GET" }),
        authorization({
          recheck: vi.fn(async () => {
            throw new Error("revoked");
          }),
        }),
        URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
        fake.repositories,
      ),
    ).rejects.toThrow("revoked");
    expect(fake.metadata).not.toHaveBeenCalled();
    expect(fake.readHandle).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("surfaces a metadata scope denial and still releases the lease", async () => {
    const fake = harness();
    fake.metadata.mockRejectedValue(new GitPublicationError("scope_denied"));
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "GET" }),
        authorization(),
        URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(fake.readHandle).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("surfaces a read transport failure and still releases the lease", async () => {
    const fake = harness();
    fake.readHandle.mockRejectedValue(new GitPublicationError("unavailable"));
    await expect(
      handleGitSmartHttp(
        fake.options,
        request({ method: "GET" }),
        authorization(),
        URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
        fake.repositories,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.release).toHaveBeenCalledTimes(1);
  });
});

describe("handleGitSmartHttp lease lifetime", () => {
  it("releases the lease when the caller abandons the read body before draining it", async () => {
    const fake = harness({
      readResponse: { chunks: [Buffer.from("first"), Buffer.from("second")] },
    });
    const response = await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    const iterator = response.body[Symbol.asyncIterator]();
    expect(Buffer.from((await iterator.next()).value as Uint8Array).toString()).toBe("first");
    // Abandoning the stream must run the release path exactly once — the IAT is not leaked.
    await iterator.return?.();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when the request signal aborts mid-body", async () => {
    const controller = new AbortController();
    const fake = harness({ readResponse: { chunks: [Buffer.from("first"), Buffer.from("second")] } });
    const base = request({ method: "GET" });
    const response = await handleGitSmartHttp(
      fake.options,
      { ...base, signal: controller.signal },
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    // The abort listener only exists once the generator has started, so pull one chunk first.
    const iterator = response.body[Symbol.asyncIterator]();
    expect(Buffer.from((await iterator.next()).value as Uint8Array).toString()).toBe("first");
    controller.abort();
    // The abort fires the release immediately, without waiting for the body to be drained.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.release).toHaveBeenCalledTimes(1);
    await iterator.return?.();
  });

  it("does not double-release when the body is drained and the signal aborts afterwards", async () => {
    const controller = new AbortController();
    const fake = harness();
    const base = request({ method: "GET" });
    const response = await handleGitSmartHttp(
      fake.options,
      { ...base, signal: controller.signal },
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    expect(await collect(response.body)).toBe("read-body");
    controller.abort();
    // The abort listener is removed once the body completes, so no second release fires.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.release).toHaveBeenCalledTimes(1);
  });
});

describe("handleGitSmartHttp repository metadata binding", () => {
  it("passes the leased token to the metadata call and never a user credential", async () => {
    const fake = harness();
    await handleGitSmartHttp(
      fake.options,
      request({ method: "GET" }),
      authorization(),
      URL_FOR("/owner/repository.git/info/refs?service=git-upload-pack"),
      fake.repositories,
    );
    expect(fake.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "123" }),
      IAT,
      expect.anything(),
    );
  });

  it("builds the publication remote from the leased token, not the caller material", async () => {
    const fake = harness();
    let seen: unknown;
    fake.receive.mockImplementation(async (input: { remote: unknown }) => {
      seen = input.remote;
      return Buffer.from("ok");
    });
    await handleGitSmartHttp(
      fake.options,
      request({ method: "POST", headers: {} }),
      authorization(),
      URL_FOR("/owner/repository.git/git-receive-pack"),
      fake.repositories,
    );
    expect(seen).toBeDefined();
    expect(Object.getOwnPropertyNames(seen as object)).toEqual([]);
  });

  it("reuses the same revalidation function for the read and publication paths", async () => {
    const fake = harness();
    const recheck = vi.fn(async () => undefined);
    await handleGitSmartHttp(
      fake.options,
      request({ method: "POST", headers: {} }),
      authorization({ recheck }),
      URL_FOR("/owner/repository.git/git-receive-pack"),
      fake.repositories,
    );
    const revalidate = fake.receive.mock.calls[0]?.[0].revalidate as () => Promise<void>;
    await revalidate();
    // One recheck before the metadata call, one for the explicit revalidate probe.
    expect(recheck).toHaveBeenCalledTimes(2);
  });
});

it("reports every rejection as a GitPublicationError with a bounded code", async () => {
  const fake = harness();
  const error = await handleGitSmartHttp(
    fake.options,
    request({ method: "GET" }),
    authorization(),
    URL_FOR("/owner/repository.git"),
    fake.repositories,
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(GitPublicationError);
  expect((error as GitPublicationError).name).toBe("GitPublicationError");
});
