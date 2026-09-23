import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_IDENTITY_FILE_NAME,
  accountIdentityPath,
  readAccountIdentity,
  removeAccountIdentity,
  writeAccountIdentityAtomically,
} from "../auth/account-identity.js";
import { readCredentials, StoredCredentialsSchema, writeCredentialsAtomically } from "../auth/credentials.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-account-identity-"));
  homes.push(home);
  return home;
}

describe("account identity file", () => {
  it("lives beside the credentials rather than inside them", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically(
      {
        accessToken: "access-token",
        accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
        refreshToken: "refresh-token",
        serverUrl: "https://opentag.example",
      },
      home,
    );
    await writeAccountIdentityAtomically({ userId: "account-1", serverUrl: "https://opentag.example/" }, home);

    expect(accountIdentityPath(home)).toBe(join(resolveOpenTagHomeLayout(home).config, ACCOUNT_IDENTITY_FILE_NAME));
    expect(await readAccountIdentity(home)).toEqual({ userId: "account-1", serverUrl: "https://opentag.example" });
    // The credentials file is untouched by the identity, and still parses strictly without it.
    const credentials = JSON.parse(
      await readFile(join(resolveOpenTagHomeLayout(home).config, "credentials.json"), "utf8"),
    );
    expect(Object.keys(credentials).sort()).toEqual([
      "accessToken",
      "accessTokenExpiresAt",
      "refreshToken",
      "serverUrl",
    ]);
    expect(StoredCredentialsSchema.safeParse(credentials).success).toBe(true);
    expect(await readCredentials(home)).not.toHaveProperty("userId");
  });

  it("is absent when never written, rejected when malformed, and removable more than once", async () => {
    const home = await temporaryHome();
    expect(await readAccountIdentity(home)).toBeUndefined();
    await removeAccountIdentity(home);

    const layout = resolveOpenTagHomeLayout(home);
    await mkdir(layout.config, { recursive: true, mode: 0o700 });
    for (const content of [
      "{not json",
      '{"userId":"account-1"}',
      '{"userId":"","serverUrl":"https://x"}',
      '{"userId":"a","serverUrl":"https://x","accessToken":"t"}',
    ]) {
      await writeFile(join(layout.config, ACCOUNT_IDENTITY_FILE_NAME), content, { mode: 0o600 });
      await expect(readAccountIdentity(home)).rejects.toThrow();
    }

    await writeAccountIdentityAtomically({ userId: "account-1", serverUrl: "https://opentag.example" }, home);
    await removeAccountIdentity(home);
    expect(await readAccountIdentity(home)).toBeUndefined();
    await removeAccountIdentity(home);
  });

  it("refuses to write an identity the schema would not read back", async () => {
    const home = await temporaryHome();
    await expect(
      writeAccountIdentityAtomically({ userId: "", serverUrl: "https://opentag.example" }, home),
    ).rejects.toThrow();
    expect(await readAccountIdentity(home)).toBeUndefined();
  });
});
