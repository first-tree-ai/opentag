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
