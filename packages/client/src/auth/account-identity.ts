import { join } from "node:path";
import { z } from "zod";
import { normalizeServerUrl } from "../api.js";
import { removeDurableFile } from "../storage/durable-file.js";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

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
 */
export const StoredAccountIdentitySchema = z
  .object({
    userId: z.string().min(1),
    serverUrl: z.string().min(1),
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
