import { mkdir, mkdtemp, readdir, stat, symlink, writeFile } from "node:fs/promises";
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
  const path = await mkdtemp(join(tmpdir(), "opentag-auth-"));
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
  it("persists a stable private identity and rejects server or user rebinding", async () => {
    const home = await temporaryHome();
    const first = await resolveComputerIdentity(home, "https://opentag.example", crypto.randomUUID());
    expect(await resolveComputerIdentity(home, first.serverUrl, first.userId)).toEqual(first);
    expect((await stat(computerIdentityPath(home))).mode & 0o777).toBe(0o600);
    await expect(resolveComputerIdentity(home, "https://other.example", first.userId)).rejects.toThrow(
      "bound to another server or user",
    );
  });

  it("does not read a legacy root Computer identity", async () => {
    const home = await temporaryHome();
    const legacy = {
      version: 1,
      computerId: crypto.randomUUID(),
      serverUrl: "https://legacy.example",
      userId: crypto.randomUUID(),
    };
    await writeFile(join(home, "computer.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const current = await resolveComputerIdentity(home, "https://opentag.example", crypto.randomUUID());
    expect(current.computerId).not.toBe(legacy.computerId);
    expect(computerIdentityPath(home)).toBe(join(home, "data", "computer.json"));
  });
});
