import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, readCredentials, resolveComputerIdentity } from "@opentag/client";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeLoginCommand, registerLoginCommand } from "../commands/login.js";
import { runLogin } from "../core/auth/login.js";
import { LoginServiceInstallError, runLoginWithService } from "../core/auth/login-service.js";
import type { DaemonServiceManager } from "../core/daemon/service/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("runLogin", () => {
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
