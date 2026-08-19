import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, readCredentials, resolveComputerIdentity } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLogin } from "../core/auth/login.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("runLogin", () => {
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

    expect(exchangeConnectCode).toHaveBeenCalledWith("one-time-secret", undefined);
    expect(result.message).toBe("Logged in to OpenTag at https://opentag.example");
    expect(result.credentialsPath).toBe(credentialsPath(home));
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(await readCredentials(home)).toMatchObject({
      accessToken: "access-secret",
      accessTokenExpiresAt: "2026-08-18T00:15:00.000Z",
      refreshToken: "refresh-secret",
    });
  });

  it("rejects another server before consuming a connect code for a bound home", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-login-"));
    temporaryDirectories.push(home);
    await resolveComputerIdentity(home, "https://opentag.example", crypto.randomUUID());
    const exchangeConnectCode = vi.fn();
    await expect(
      runLogin({ api: { exchangeConnectCode }, code: "one-time-secret", home, serverUrl: "https://other.example" }),
    ).rejects.toThrow("bound to another server");
    expect(exchangeConnectCode).not.toHaveBeenCalled();
  });
});
