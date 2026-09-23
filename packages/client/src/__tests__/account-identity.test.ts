import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_IDENTITY_FILE_NAME,
  accountIdentityMatchesCredentials,
  accountIdentityPath,
  credentialsFingerprint,
  readAccountIdentity,
  removeAccountIdentity,
  rotateAccountIdentityFingerprint,
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

const credentials = {
  accessToken: "access-token",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  refreshToken: "refresh-token",
  serverUrl: "https://opentag.example",
};
const fingerprint = credentialsFingerprint(credentials);

describe("credentialsFingerprint", () => {
  it("is a hex SHA-256 of the refresh token that never contains the token", () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(credentialsFingerprint({ refreshToken: "refresh-token" }));
    expect(fingerprint).not.toBe(credentialsFingerprint({ refreshToken: "other-refresh-token" }));
    expect(fingerprint).not.toContain("refresh-token");
    // The access token plays no part: a refresh that keeps the refresh token keeps the binding.
    expect(credentialsFingerprint({ ...credentials, accessToken: "rotated" } as typeof credentials)).toBe(fingerprint);
    expect(accountIdentityMatchesCredentials({ credentialsFingerprint: fingerprint }, credentials)).toBe(true);
    expect(accountIdentityMatchesCredentials({ credentialsFingerprint: fingerprint }, { refreshToken: "b" })).toBe(
      false,
    );
  });
});

describe("account identity file", () => {
  it("lives beside the credentials rather than inside them, bound to them by fingerprint", async () => {
    const home = await temporaryHome();
    await writeCredentialsAtomically(credentials, home);
    await writeAccountIdentityAtomically(
      { userId: "account-1", serverUrl: "https://opentag.example/", credentialsFingerprint: fingerprint },
      home,
    );

    expect(accountIdentityPath(home)).toBe(join(resolveOpenTagHomeLayout(home).config, ACCOUNT_IDENTITY_FILE_NAME));
    expect(await readAccountIdentity(home)).toEqual({
      userId: "account-1",
      serverUrl: "https://opentag.example",
      credentialsFingerprint: fingerprint,
    });
    // The credentials file is untouched by the identity, and still parses strictly without it.
    const layout = resolveOpenTagHomeLayout(home);
    const stored = JSON.parse(await readFile(join(layout.config, "credentials.json"), "utf8"));
    expect(Object.keys(stored).sort()).toEqual(["accessToken", "accessTokenExpiresAt", "refreshToken", "serverUrl"]);
    expect(StoredCredentialsSchema.safeParse(stored).success).toBe(true);
    expect(await readCredentials(home)).not.toHaveProperty("userId");
    // The identity file holds a hash of the refresh token, never the token.
    expect(await readFile(join(layout.config, ACCOUNT_IDENTITY_FILE_NAME), "utf8")).not.toContain("refresh-token");
  });

  it("is absent when never written, rejected when malformed or unbound, and removable more than once", async () => {
    const home = await temporaryHome();
    expect(await readAccountIdentity(home)).toBeUndefined();
    await removeAccountIdentity(home);

    const layout = resolveOpenTagHomeLayout(home);
    await mkdir(layout.config, { recursive: true, mode: 0o700 });
    for (const content of [
      "{not json",
      '{"userId":"account-1"}',
      // The shape an earlier head of this branch wrote, without a fingerprint: unprovable, so rejected.
      '{"userId":"account-1","serverUrl":"https://opentag.example"}',
      `{"userId":"","serverUrl":"https://x","credentialsFingerprint":"${fingerprint}"}`,
      '{"userId":"a","serverUrl":"https://x","credentialsFingerprint":"not-a-hash"}',
      `{"userId":"a","serverUrl":"https://x","credentialsFingerprint":"${fingerprint}","accessToken":"t"}`,
    ]) {
      await writeFile(join(layout.config, ACCOUNT_IDENTITY_FILE_NAME), content, { mode: 0o600 });
      await expect(readAccountIdentity(home)).rejects.toThrow();
    }

    await writeAccountIdentityAtomically(
      { userId: "account-1", serverUrl: "https://opentag.example", credentialsFingerprint: fingerprint },
      home,
    );
    await removeAccountIdentity(home);
    expect(await readAccountIdentity(home)).toBeUndefined();
    await removeAccountIdentity(home);
  });

  it("refuses to write an identity the schema would not read back", async () => {
    const home = await temporaryHome();
    await expect(
      writeAccountIdentityAtomically(
        { userId: "", serverUrl: "https://opentag.example", credentialsFingerprint: fingerprint },
        home,
      ),
    ).rejects.toThrow();
    expect(await readAccountIdentity(home)).toBeUndefined();
  });

  it("follows a refresh token rotation only when it belonged to the replaced credentials", async () => {
    const home = await temporaryHome();
    const rotation = { previous: { refreshToken: "refresh-token" }, next: { refreshToken: "rotated-token" } };
    expect(await rotateAccountIdentityFingerprint(rotation, home)).toBe("absent");

    await writeAccountIdentityAtomically(
      { userId: "account-1", serverUrl: "https://opentag.example", credentialsFingerprint: fingerprint },
      home,
    );
    expect(await rotateAccountIdentityFingerprint(rotation, home)).toBe("rebound");
    expect((await readAccountIdentity(home))?.credentialsFingerprint).toBe(
      credentialsFingerprint({ refreshToken: "rotated-token" }),
    );

    // A file that did not belong to the replaced credentials is left exactly as it was.
    expect(await rotateAccountIdentityFingerprint(rotation, home)).toBe("unbound");
    expect((await readAccountIdentity(home))?.credentialsFingerprint).toBe(
      credentialsFingerprint({ refreshToken: "rotated-token" }),
    );
  });
});
