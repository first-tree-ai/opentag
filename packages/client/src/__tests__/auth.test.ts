import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeServerUrl, OpenTagApi, OpenTagApiError } from "../api.js";
import {
  credentialsPath,
  readCredentials,
  type StoredCredentials,
  writeCredentialsAtomically,
} from "../auth/credentials.js";
import { AccessTokenProvider } from "../auth/token-provider.js";
import { type RequestOptions, safeCause, statusFallback, validTimeout } from "../request-policy.js";
import { computerIdentityPath, resolveComputerIdentity } from "../runtime/computer-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryHome(): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const path = await realpath(await mkdtemp(join(tmpdir(), "opentag-auth-")));
  temporaryDirectories.push(path);
  return path;
}

const credentials: StoredCredentials = {
  accessToken: "access",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  refreshToken: "refresh",
  serverUrl: "https://opentag.example",
};

describe("credential storage", () => {
  it("uses private permissions and atomic replacement", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically(credentials, home);
    await writeCredentialsAtomically({ ...credentials, accessToken: "next" }, home);

    expect(await readCredentials(home)).toEqual({ ...credentials, accessToken: "next" });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "config"))).mode & 0o777).toBe(0o700);
    expect((await stat(credentialsPath(home))).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(["config"]);
    expect(await readdir(join(home, "config"))).toEqual(["credentials.json"]);
  });

  it("rejects a symlinked canonical home", async () => {
    const root = await temporaryHome();
    const target = join(root, "target");
    const linkedHome = join(root, "linked-home");
    await mkdir(target);
    await symlink(target, linkedHome, "dir");

    await expect(writeCredentialsAtomically(credentials, linkedHome)).rejects.toThrow(/real director/i);
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects a symlinked nested config directory", async () => {
    const home = await temporaryHome();
    const external = await temporaryHome();
    await symlink(external, join(home, "config"), "dir");

    await expect(writeCredentialsAtomically(credentials, home)).rejects.toThrow(/real director/i);
    expect(await readdir(external)).toEqual([]);
  });

  it("does not read legacy root credentials", async () => {
    const home = await temporaryHome();
    await writeFile(join(home, "credentials.json"), `${JSON.stringify(credentials)}\n`, { mode: 0o600 });

    await expect(readCredentials(home)).resolves.toBeUndefined();
  });

  it("reports malformed files without masking an invalid server URL", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, "config"), { mode: 0o700 });
    await writeFile(credentialsPath(home), `${JSON.stringify({ ...credentials, accessToken: "" })}\n`, { mode: 0o600 });
    await expect(readCredentials(home)).rejects.toThrow("credentials file is invalid");

    await writeFile(
      credentialsPath(home),
      `${JSON.stringify({ ...credentials, serverUrl: "https://opentag.example/api" })}\n`,
      { mode: 0o600 },
    );
    await expect(readCredentials(home)).rejects.toThrow("origin without a path");
  });
});

describe("OpenTagApi", () => {
  it("rejects server URLs that could persist or print embedded credentials", () => {
    expect(() => normalizeServerUrl("https://user:secret@opentag.example")).toThrow();
    expect(() => normalizeServerUrl("file:///tmp/server")).toThrow();
    expect(() => normalizeServerUrl("https://opentag.example/api")).toThrow(
      "The OpenTag server URL must be an origin without a path, query, or fragment",
    );
    expect(normalizeServerUrl("https://opentag.example/")).toBe("https://opentag.example");
  });

  it("allows HTTPS and loopback HTTP but rejects remote plaintext origins", () => {
    expect(normalizeServerUrl("https://opentag.example")).toBe("https://opentag.example");
    expect(normalizeServerUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(normalizeServerUrl("http://localhost:8000")).toBe("http://localhost:8000");
    expect(() => normalizeServerUrl("http://opentag.example")).toThrow(
      "Plain HTTP is allowed only for loopback OpenTag servers",
    );
  });

  it.each([
    [429, "rate_limit"],
    [503, "transient"],
  ] as const)("classifies HTTP %s without exposing response secrets", async (status, category) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ accessToken: "leaked", refreshToken: "leaked" }), { status }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    const error = await api.exchangeConnectCode("1234567890abcdef").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenTagApiError);
    expect(error).toMatchObject({ category });
    expect(String(error)).not.toContain("leaked");
  });

  it("aborts a hanging request at the configured deadline and includes a request ID", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
      const api = new OpenTagApi("https://opentag.example", fetchImpl, { timeoutMs: 25 });
      const pending = api.me("access").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toMatchObject({
        code: "REQUEST_TIMEOUT",
        category: "transient",
        retryability: "backoff",
        phase: "transport",
        requestId: expect.any(String),
      });
      expect(observedSignal?.aborted).toBe(true);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-request-id")).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the caller abort reason as the safe cause", async () => {
    const reason = new Error("caller stopped this request");
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw reason;
    });
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    const pending = api.me("access", { signal: controller.signal });
    controller.abort(reason);
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "REQUEST_CANCELLED",
      category: "deterministic",
      retryability: "never",
      phase: "request",
      cause: reason,
    });
  });

  it.each([
    [400, "validation", "VALIDATION_ERROR"],
    [404, "deterministic", "RESOURCE_NOT_FOUND"],
    [409, "deterministic", "VALIDATION_ERROR"],
    [429, "rate_limit", "RATE_LIMITED"],
    [500, "transient", "SERVICE_UNAVAILABLE"],
  ] as const)("maps a malformed HTTP %s response without treating it as auth", async (status, category, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);

    const error = await api.me("access").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, category, requestId: expect.any(String) });
    expect((error as OpenTagApiError).category).not.toBe("credential");
  });

  it("maps no-content failures and uses deterministic fallback categories", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status: 404 }));
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    await expect(api.deleteAgent("access", crypto.randomUUID())).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      category: "deterministic",
    });
    expect(statusFallback(401)).toMatchObject({ code: "AUTH_INVALID_TOKEN", category: "credential" });
    expect(statusFallback(418)).toMatchObject({ code: "VALIDATION_ERROR", category: "validation" });
  });

  it("accepts a direct AbortSignal and validates timeout options", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    const fetchImpl = vi.fn<typeof fetch>();
    const api = new OpenTagApi("https://opentag.example", fetchImpl);
    await expect(api.me("access", controller.signal as unknown as RequestOptions)).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    expect(() => validTimeout(0)).toThrow("positive safe integer");
    expect(() => validTimeout(25)).not.toThrow();
  });

  it("sanitizes structured and primitive transport causes", () => {
    expect(safeCause("Bearer secret-token")).toEqual({ message: "Bearer [REDACTED]" });
    const cause = new Error("request failed", { cause: Object.assign(new Error("token=secret"), { code: "EFAIL" }) });
    expect(safeCause(cause)).toEqual({
      message: "request failed",
      cause: { code: "EFAIL", message: "token=[REDACTED]" },
    });
  });
});

describe("AccessTokenProvider", () => {
  it("rotates an access token before it expires and persists the response", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, accessTokenExpiresAt: "2026-08-18T00:00:30.000Z" }, home);
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    const provider = new AccessTokenProvider({
      api: { refresh },
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });

    await expect(provider.getAccessToken()).resolves.toBe("new-access");
    expect(refresh).toHaveBeenCalledWith("refresh");
    expect(await readCredentials(home)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accessTokenExpiresAt: "2026-08-18T00:15:00.000Z",
    });
  });

  it("coalesces concurrent refreshes and returns token leases", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, accessTokenExpiresAt: "2026-08-18T00:00:30.000Z" }, home);
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    const provider = new AccessTokenProvider({
      api: { refresh },
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });
    await expect(Promise.all([provider.getAccessTokenLease(), provider.getAccessTokenLease()])).resolves.toEqual([
      { accessToken: "new-access", expiresAt: "2026-08-18T00:15:00.000Z" },
      { accessToken: "new-access", expiresAt: "2026-08-18T00:15:00.000Z" },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a rotated refresh token when separate providers refresh one credential concurrently", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, accessTokenExpiresAt: "2026-08-18T00:00:30.000Z" }, home);
    let resolveFirst:
      | ((value: { accessToken: string; refreshToken: string; tokenType: "Bearer"; expiresIn: number }) => void)
      | undefined;
    const firstRefresh = vi.fn(
      () =>
        new Promise<{ accessToken: string; refreshToken: string; tokenType: "Bearer"; expiresIn: number }>(
          (resolve) => {
            resolveFirst = resolve;
          },
        ),
    );
    const secondRefresh = vi.fn().mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    const first = new AccessTokenProvider({
      api: { refresh: firstRefresh },
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
      lockRetryMs: 1,
    });
    const second = new AccessTokenProvider({
      api: { refresh: secondRefresh },
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
      lockRetryMs: 1,
    });

    const firstPending = first.getAccessToken();
    await vi.waitFor(() => expect(firstRefresh).toHaveBeenCalledWith("refresh"));
    const secondPending = second.getAccessToken();
    resolveFirst?.({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    await expect(firstPending).resolves.toBe("rotated-access");
    await expect(secondPending).resolves.toBe("rotated-access");
    await expect(readCredentials(home)).resolves.toMatchObject({ refreshToken: "rotated-refresh" });
    // The second provider waited for the lock, reloaded the winner, and did not overwrite its refresh token.
    expect(secondRefresh).not.toHaveBeenCalled();
  });

  it("rejects invalid lock settings and unsafe refresh expiry", async () => {
    expect(() => new AccessTokenProvider({ lockRetryMs: 0 })).toThrow("lockRetryMs");
    expect(() => new AccessTokenProvider({ lockRetryMs: 10, lockTimeoutMs: 5 })).toThrow("lockTimeoutMs");

    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, accessTokenExpiresAt: "2026-08-18T00:00:30.000Z" }, home);
    const provider = new AccessTokenProvider({
      api: {
        refresh: vi.fn().mockResolvedValue({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          tokenType: "Bearer",
          expiresIn: 1,
        }),
      },
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });
    await expect(provider.getAccessToken()).rejects.toThrow("unsafe token expiry");
  });

  it("times out cleanly when a credential lock points at a missing target", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, accessTokenExpiresAt: "2026-08-18T00:00:30.000Z" }, home);
    await symlink("missing-lock-target", join(home, "config", ".credentials.lock"));
    const provider = new AccessTokenProvider({
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
      lockRetryMs: 1,
      lockTimeoutMs: 5,
    });
    await expect(provider.getAccessToken()).rejects.toThrow("refresh lock");
  });

  it("propagates an unexpected credential lock filesystem error", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, accessTokenExpiresAt: "2026-08-18T00:00:30.000Z" }, home);
    let removedConfig = false;
    const provider = new AccessTokenProvider({
      home,
      now: () => {
        if (!removedConfig) {
          rmSync(join(home, "config"), { force: true, recursive: true });
          removedConfig = true;
        }
        return new Date("2026-08-18T00:00:00.000Z");
      },
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("credential validation", () => {
  it.each([
    ["accessToken", { accessToken: "" }],
    ["refreshToken", { refreshToken: "   " }],
    ["expiry", { accessTokenExpiresAt: "1970-01-01T00:00:00.000Z" }],
    ["server URL", { serverUrl: "https://opentag.example/api" }],
  ] as const)("rejects a weak stored %s", async (_label, override) => {
    const home = await temporaryHome();
    await expect(writeCredentialsAtomically({ ...credentials, ...override }, home)).rejects.toThrow();
  });

  it("normalizes a valid origin before storing it", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically({ ...credentials, serverUrl: "https://opentag.example/" }, home);
    await expect(readCredentials(home)).resolves.toMatchObject({ serverUrl: "https://opentag.example" });
  });
});

describe("Computer identity", () => {
  it("persists a stable private physical identity and rejects server rebinding", async () => {
    const home = await temporaryHome();
    const first = await resolveComputerIdentity(home, "https://opentag.example");
    expect(await resolveComputerIdentity(home, first.serverUrl)).toEqual(first);
    expect(computerIdentityPath(home)).toBe(join(home, "config", "computer.json"));
    expect((await stat(computerIdentityPath(home))).mode & 0o777).toBe(0o600);
    await expect(resolveComputerIdentity(home, "https://other.example")).rejects.toThrow("bound to another server");
  });

  it("upgrades the current v1 Account-bound identity without changing the physical Computer ID", async () => {
    const home = await temporaryHome();
    const rootLegacy = {
      version: 1,
      computerId: crypto.randomUUID(),
      serverUrl: "https://root-legacy.example",
      userId: crypto.randomUUID(),
    };
    const dataLegacy = {
      version: 1,
      computerId: crypto.randomUUID(),
      serverUrl: "https://data-legacy.example",
      userId: crypto.randomUUID(),
    };
    const rootLegacyPath = join(home, "computer.json");
    const dataLegacyPath = join(home, "data", "computer.json");
    await mkdir(join(home, "data"), { mode: 0o700 });
    await writeFile(rootLegacyPath, `${JSON.stringify(rootLegacy)}\n`, { mode: 0o600 });
    await writeFile(dataLegacyPath, `${JSON.stringify(dataLegacy)}\n`, { mode: 0o600 });

    await mkdir(join(home, "config"), { mode: 0o700 });
    await writeFile(computerIdentityPath(home), `${JSON.stringify(rootLegacy)}\n`, { mode: 0o600 });

    const current = await resolveComputerIdentity(home, rootLegacy.serverUrl);
    expect(current).toEqual({ version: 2, computerId: rootLegacy.computerId, serverUrl: rootLegacy.serverUrl });
    expect(current.computerId).not.toBe(dataLegacy.computerId);
    expect(await readFile(rootLegacyPath, "utf8")).toBe(`${JSON.stringify(rootLegacy)}\n`);
    expect(await readFile(dataLegacyPath, "utf8")).toBe(`${JSON.stringify(dataLegacy)}\n`);
  });

  it("rejects a symlinked nested config directory", async () => {
    const home = await temporaryHome();
    const external = await temporaryHome();
    await symlink(external, join(home, "config"), "dir");

    await expect(resolveComputerIdentity(home, "https://opentag.example")).rejects.toThrow(/real director/i);
    expect(await readdir(external)).toEqual([]);
  });

  it("rejects a non-directory nested config path", async () => {
    const home = await temporaryHome();
    await writeFile(join(home, "config"), "not-a-directory", "utf8");

    await expect(resolveComputerIdentity(home, "https://opentag.example")).rejects.toThrow(/real director/i);
  });
});
