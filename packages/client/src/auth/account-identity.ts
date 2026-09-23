import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { normalizeServerUrl } from "../api.js";
import { removeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";
import type { StoredCredentials } from "./credentials.js";

/**
 * Which Account this OpenTag home last signed in as, kept beside `credentials.json` rather than in
 * it.
 *
 * The credentials file is read by a strict schema, and every CLI already installed reads it with
 * the schema it shipped with: a key added to that file by a newer CLI makes the file invalid for an
 * older one, so the documented rollback (`install.sh --version <previous>`) would leave every
 * Account-authenticated command refusing to run. This attribution is a diagnostic detail, not a
 * credential, so it lives in its own optional file that an older CLI never opens. The `serverUrl`
 * is recorded so an identity left behind by a sign-in to one server is never attributed to a
 * sign-in to another.
 *
 * `credentialsFingerprint` ties the identity to the credentials it was written beside. Rollback is
 * a supported sequence, and an older CLI signing in as another Account rewrites only
 * `credentials.json`, leaving this file naming the previous Account on the same server. The
 * fingerprint is a hash of the refresh token — never the token — so a reader can prove the file
 * still describes the credentials it reads, and omit the Account when it cannot. A file written
 * before the field existed fails the strict schema and is treated as absent, which is the safe
 * direction: no attribution rather than a wrong one.
 */
export const StoredAccountIdentitySchema = z
  .object({
    userId: z.string().min(1),
    serverUrl: z.string().min(1),
    credentialsFingerprint: z.string().regex(/^[0-9a-f]{64}$/, "A credentials fingerprint is a hex SHA-256"),
  })
  .strict();

export type StoredAccountIdentity = z.infer<typeof StoredAccountIdentitySchema>;

export const ACCOUNT_IDENTITY_FILE_NAME = "account-identity.json";

export function accountIdentityPath(home = resolveOpenTagHome()): string {
  return join(resolveOpenTagHomeLayout(home).config, ACCOUNT_IDENTITY_FILE_NAME);
}

/** Throws on a malformed file, like the other identity readers; a caller decides what that costs. */
export function readAccountIdentity(home = resolveOpenTagHome()): Promise<StoredAccountIdentity | undefined> {
  return readPrivateJson(home, accountIdentityPath(home), validateAccountIdentity);
}

export async function writeAccountIdentityAtomically(
  identity: StoredAccountIdentity,
  home = resolveOpenTagHome(),
): Promise<void> {
  await writePrivateJson(home, accountIdentityPath(home), normalizeAccountIdentity(identity));
}

/**
 * The fingerprint an identity file carries for a set of credentials: a hex SHA-256 of the refresh
 * token. The refresh token rather than the access token because it is the credential that
 * outlives a refresh cycle and changes only when the credentials are rotated or replaced; and a
 * hash rather than the token so the identity file never holds a secret.
 */
export function credentialsFingerprint(credentials: Pick<StoredCredentials, "refreshToken">): string {
  return createHash("sha256").update(credentials.refreshToken, "utf8").digest("hex");
}

/** Whether an identity file was written beside these credentials. */
export function accountIdentityMatchesCredentials(
  identity: Pick<StoredAccountIdentity, "credentialsFingerprint">,
  credentials: Pick<StoredCredentials, "refreshToken">,
): boolean {
  return identity.credentialsFingerprint === credentialsFingerprint(credentials);
}

export type AccountIdentityRotation = "rebound" | "unbound" | "absent";

/**
 * Carry the identity over a refresh token rotation.
 *
 * Only an identity that provably belonged to the replaced credentials is rebound to the new ones;
 * one that did not match is left exactly as it was, so a stale file stays unprovable and keeps
 * being ignored. Throws like any other identity read or write; the caller decides that a refresh
 * must not fail over it.
 */
export async function rotateAccountIdentityFingerprint(
  input: {
    previous: Pick<StoredCredentials, "refreshToken">;
    next: Pick<StoredCredentials, "refreshToken">;
  },
  home = resolveOpenTagHome(),
): Promise<AccountIdentityRotation> {
  const identity = await readAccountIdentity(home);
  if (!identity) return "absent";
  if (!accountIdentityMatchesCredentials(identity, input.previous)) return "unbound";
  await writeAccountIdentityAtomically(
    { ...identity, credentialsFingerprint: credentialsFingerprint(input.next) },
    home,
  );
  return "rebound";
}

/** Forgets the Account; a home that has no identity file is left as it is. */
export async function removeAccountIdentity(home = resolveOpenTagHome()): Promise<void> {
  try {
    await removeDurableFile(accountIdentityPath(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function validateAccountIdentity(value: unknown): StoredAccountIdentity {
  try {
    return normalizeAccountIdentity(StoredAccountIdentitySchema.parse(value));
  } catch (error) {
    throw new Error("The OpenTag account identity file is invalid", { cause: error });
  }
}

function normalizeAccountIdentity(value: unknown): StoredAccountIdentity {
  const parsed = StoredAccountIdentitySchema.parse(value);
  return { ...parsed, serverUrl: normalizeServerUrl(parsed.serverUrl) };
}
