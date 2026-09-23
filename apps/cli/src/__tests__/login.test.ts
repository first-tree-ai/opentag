import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountIdentityPath,
  credentialsPath,
  readAccountIdentity,
  readCredentials,
  resolveComputerIdentity,
  writeAccountIdentityAtomically,
} from "@opentag/client";
import { getChannelConfig } from "@opentag/shared";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeLoginCommand, registerLoginCommand } from "../commands/login.js";
import { runLogin } from "../core/auth/login.js";
import { LoginServiceInstallError, runLoginWithService } from "../core/auth/login-service.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";
import { resolveErrorReportTarget } from "../core/diagnostics/error-reporting.js";

const temporaryDirectories: string[] = [];

/**
 * `StoredCredentialsSchema` exactly as `main` reads `credentials.json`, copied from
 * `packages/client/src/auth/credentials.ts` at commit `c939776a` rather than imported, so this test
 * keeps describing the reader a rolled-back CLI would run even after the live schema moves on.
 * That reader is strict: any key it does not name makes the whole file invalid.
 */
const LEGACY_STORED_CREDENTIALS_SCHEMA = z
  .object({
    accessToken: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "Token must not be blank"),
    accessTokenExpiresAt: z
      .string()
      .datetime({ offset: true })
      .refine((value) => Date.parse(value) >= Date.UTC(2000, 0, 1), "Token expiry is too weak"),
    refreshToken: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "Token must not be blank"),
    serverUrl: z.string().min(1),
  })
  .strict();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("runLogin", () => {
  it("defaults the server to the bound Computer identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    await resolveComputerIdentity(home, "https://staging.example");
    const login = vi.fn().mockResolvedValue({ credentialsPath: "/private/credentials.json", message: "Logged in" });

    await expect(executeLoginCommand("one-time-code", { home }, { login })).resolves.toBe(0);

    expect(login).toHaveBeenCalledWith({
      code: "one-time-code",
      home,
      serverUrl: "https://staging.example",
    });
  });

  it("requires an explicit server for a channel without a default or bound Computer", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    const login = vi.fn();
    const staging = getChannelConfig("staging", "/tmp");

    await expect(
      executeLoginCommand("one-time-code", { home }, { channelConfig: staging, environment: {}, login }),
    ).rejects.toThrow("The staging channel has no server URL; pass --server <url> to opentag-staging login");
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps an explicit server override for runLogin validation", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    await resolveComputerIdentity(home, "https://staging.example");
    const login = vi.fn().mockResolvedValue({ credentialsPath: "/private/credentials.json", message: "Logged in" });

    await expect(
      executeLoginCommand("one-time-code", { home, server: "https://other.example" }, { login }),
    ).resolves.toBe(0);
    expect(login).toHaveBeenCalledWith({
      code: "one-time-code",
      home,
      serverUrl: "https://other.example",
    });
  });

  it("parses a leading-hyphen connect code after the option terminator", async () => {
    const login = vi.fn().mockResolvedValue({ credentialsPath: "/private/credentials.json", message: "Logged in" });
    const program = new Command().name("opentag").exitOverride();
    registerLoginCommand(program, { login, writeOutput: vi.fn() });

    await program.parseAsync([
      "node",
      "opentag",
      "login",
      "--server",
      "https://opentag.example",
      "--",
      "-R5hUHv2GVEjyiKiBLCyzgi-yef7_tQ5",
    ]);

    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "-R5hUHv2GVEjyiKiBLCyzgi-yef7_tQ5",
        serverUrl: "https://opentag.example",
      }),
    );
  });

  it("presents login success as one JSON document", async () => {
    const login = vi.fn().mockResolvedValue({ credentialsPath: "/private/credentials.json", message: "Logged in" });
    const output: string[] = [];
    const program = new Command().name("opentag");
    registerLoginCommand(program, { login, writeOutput: (message) => output.push(message) });
    await program.parseAsync(["node", "opentag", "login", "code", "--server", "https://opentag.example", "--json"]);
    expect(login).toHaveBeenCalledWith({
      code: "code",
      home: expect.any(String),
      serverUrl: "https://opentag.example",
    });
    expect(output).toEqual([]);
  });

  it("stores credentials without returning or printing secrets", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    const exchangeConnectCode = vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      expiresIn: 900,
    });

    const result = await runLogin({
      api: { exchangeConnectCode },
      code: "one-time-secret",
      home,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
      serverUrl: "https://opentag.example",
    });

    expect(exchangeConnectCode).toHaveBeenCalledWith("one-time-secret");
    expect(result.message).toBe("Logged in to OpenTag at https://opentag.example");
    expect(result.credentialsPath).toBe(credentialsPath(home));
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await readCredentials(home)).toMatchObject({
      accessToken: "access-secret",
      accessTokenExpiresAt: "2026-08-18T00:15:00.000Z",
      refreshToken: "refresh-secret",
    });
    expect(await readdir(home)).toEqual(["config"]);
  });

  it("records the Account beside the credentials, and signs in anyway when it cannot be read", async () => {
    const exchangeConnectCode = vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    const login = async (home: string, me?: () => Promise<{ user: { id: string } }>) => {
      await runLogin({
        api: { exchangeConnectCode, ...(me ? { me } : {}) } as Parameters<typeof runLogin>[0]["api"],
        code: "one-time-secret",
        home,
        serverUrl: "https://opentag.example",
      });
      return { credentials: await readCredentials(home), account: await readAccountIdentity(home) };
    };
    const freshHome = async () => {
      const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
      temporaryDirectories.push(home);
      return home;
    };

    const named = await login(await freshHome(), async () => ({ user: { id: "account-1" } }));
    expect(named.account).toEqual({ userId: "account-1", serverUrl: "https://opentag.example" });
    expect(named.credentials).not.toHaveProperty("userId");

    // The sign-in has already succeeded by then; a diagnostic detail must not undo it.
    const unreadable = await login(await freshHome(), async () => {
      throw new Error("unreachable");
    });
    expect(unreadable.account).toBeUndefined();
    expect(unreadable.credentials?.accessToken).toBe("access-secret");
    expect((await login(await freshHome())).account).toBeUndefined();

    // A sign-in that cannot name its Account forgets the one a previous sign-in left behind.
    const stale = await freshHome();
    await writeAccountIdentityAtomically({ userId: "account-0", serverUrl: "https://opentag.example" }, stale);
    expect((await login(stale)).account).toBeUndefined();
  });

  it("writes a credentials file the reader on main still accepts, so a rollback keeps working", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    const exchangeConnectCode = vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      expiresIn: 900,
    });

    await runLogin({
      api: { exchangeConnectCode, me: async () => ({ user: { id: "account-1" } }) } as unknown as Parameters<
        typeof runLogin
      >[0]["api"],
      code: "one-time-secret",
      home,
      serverUrl: "https://opentag.example",
    });

    // New writer, old reader: the file on disk, parsed by the strict schema a rolled-back CLI runs.
    const written: unknown = JSON.parse(await readFile(credentialsPath(home), "utf8"));
    const legacy = LEGACY_STORED_CREDENTIALS_SCHEMA.safeParse(written);
    expect(legacy.success).toBe(true);
    expect(Object.keys(written as object).sort()).toEqual([
      "accessToken",
      "accessTokenExpiresAt",
      "refreshToken",
      "serverUrl",
    ]);
    // The same reader rejects the shape this branch used to write, which is the whole point.
    expect(LEGACY_STORED_CREDENTIALS_SCHEMA.safeParse({ ...(written as object), userId: "account-1" }).success).toBe(
      false,
    );
    // The attribution is beside the credentials, and the report reads it from there.
    expect(await readAccountIdentity(home)).toEqual({ userId: "account-1", serverUrl: "https://opentag.example" });
    expect(await resolveErrorReportTarget(home)).toMatchObject({
      serverUrl: "https://opentag.example",
      userId: "account-1",
    });
  });

  it("does not fail a login over an identity file it cannot write", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    const warnings: string[] = [];
    const exchangeConnectCode = vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      expiresIn: 900,
    });

    // A directory squatting on the identity path makes the atomic write fail; the login must not notice.
    await mkdir(accountIdentityPath(home), { recursive: true, mode: 0o700 });
    await expect(
      runLogin({
        api: { exchangeConnectCode, me: async () => ({ user: { id: "account-1" } }) } as unknown as Parameters<
          typeof runLogin
        >[0]["api"],
        code: "one-time-secret",
        home,
        serverUrl: "https://opentag.example",
        logger: { warn: (_fields, message) => void warnings.push(message) },
      }),
    ).resolves.toMatchObject({ credentialsPath: credentialsPath(home) });

    expect(await readCredentials(home)).toMatchObject({ accessToken: "access-secret" });
    expect(warnings).toEqual(["Signed in, but the Account could not be recorded for diagnostics"]);
  });

  it("rejects another server before consuming a connect code for a bound home", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    await resolveComputerIdentity(home, "https://opentag.example");
    const exchangeConnectCode = vi.fn();
    await expect(
      runLogin({ api: { exchangeConnectCode }, code: "one-time-secret", home, serverUrl: "https://other.example" }),
    ).rejects.toThrow("bound to another server");
    expect(exchangeConnectCode).not.toHaveBeenCalled();
  });

  it("preflights the service before consuming a connect code", async () => {
    const login = vi.fn();
    const manager = fakeManager();
    manager.preflight = vi.fn().mockRejectedValue(new Error("unsupported"));

    await expect(
      runLoginWithService({ code: "one-time-secret", login, manager, serverUrl: "https://opentag.example" }),
    ).rejects.toThrow("unsupported");

    expect(login).not.toHaveBeenCalled();
    expect(manager.installAndStart).not.toHaveBeenCalled();
  });

  it("installs the service after credentials are written", async () => {
    const order: string[] = [];
    const login = vi.fn(async () => {
      order.push("login");
      return { credentialsPath: "/private/credentials.json", message: "Logged in" };
    });
    const manager = fakeManager(order);

    const result = await runLoginWithService({
      code: "one-time-secret",
      login,
      manager,
      serverUrl: "https://opentag.example",
    });

    expect(order).toEqual(["preflight", "login", "install"]);
    expect(result.service?.state).toBe("active");
  });

  it("skips all service work with --no-start", async () => {
    const login = vi.fn().mockResolvedValue({ credentialsPath: "/private/credentials.json", message: "Logged in" });
    const manager = fakeManager();

    const result = await runLoginWithService({
      code: "one-time-secret",
      login,
      manager,
      noStart: true,
      serverUrl: "https://opentag.example",
    });

    expect(result.service).toBeUndefined();
    expect(manager.preflight).not.toHaveBeenCalled();
    expect(manager.installAndStart).not.toHaveBeenCalled();
  });

  it("retains the successful login result when service installation fails", async () => {
    const login = vi.fn().mockResolvedValue({ credentialsPath: "/private/credentials.json", message: "Logged in" });
    const manager = fakeManager();
    manager.installAndStart = vi.fn().mockRejectedValue(new Error("manager failed"));

    const error = await runLoginWithService({
      code: "one-time-secret",
      login,
      manager,
      serverUrl: "https://opentag.example",
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LoginServiceInstallError);
    expect((error as LoginServiceInstallError).loginResult.message).toBe("Logged in");
    expect(JSON.stringify(error)).not.toContain("one-time-secret");
    expect(login).toHaveBeenCalledOnce();
  });

  it("surfaces Account login failures without daemon partial-success messaging", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const loginResult = { credentialsPath: "/private/credentials.json", message: "Logged in" };
    const login = vi.fn().mockRejectedValue(new LoginServiceInstallError(loginResult, { cause: new Error("secret") }));

    await expect(
      executeLoginCommand(
        "one-time-secret",
        { server: "https://opentag.example" },
        { login, writeError: (message) => errors.push(message), writeOutput: (message) => output.push(message) },
      ),
    ).rejects.toBeInstanceOf(LoginServiceInstallError);

    expect(output).toEqual([]);
    expect(errors).toEqual([]);
    expect(`${output.join(" ")} ${errors.join(" ")}`).not.toMatch(/one-time-secret|refresh|access/iu);
    expect(login).toHaveBeenCalledOnce();
  });
});

function fakeManager(order: string[] = []): DaemonServiceManager {
  const info = {
    currentHome: "/home/user/.opentag-dev",
    definitionPath: "/unit/opentag-dev.service",
    drifted: false,
    logHint: "logs",
    platform: "systemd" as const,
    serviceId: "opentag-dev",
    state: "active" as const,
  };
  return {
    preflight: vi.fn(async () => {
      order.push("preflight");
    }),
    installAndStart: vi.fn(async () => {
      order.push("install");
      return info;
    }),
    refreshDefinition: vi.fn(async () => info),
    restart: vi.fn(async () => info),
    start: vi.fn(async () => info),
    status: vi.fn(async () => info),
    stop: vi.fn(async () => ({ ...info, state: "inactive" as const })),
    uninstall: vi.fn(async () => ({ ...info, state: "not-installed" as const })),
  };
}
