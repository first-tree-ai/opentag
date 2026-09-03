import { join } from "node:path";
import { z } from "zod";
import { normalizeServerUrl } from "../api.js";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

export { resolveOpenTagHome } from "../storage/home-layout.js";

export interface StoredCredentials {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  serverUrl: string;
}

export const CREDENTIALS_FILE_NAME = "credentials.json";

const nonEmptyToken = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Token must not be blank");
const expiry = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) >= Date.UTC(2000, 0, 1), "Token expiry is too weak");

export const StoredCredentialsSchema = z
  .object({
    accessToken: nonEmptyToken,
    accessTokenExpiresAt: expiry,
    refreshToken: nonEmptyToken,
    serverUrl: z.string().min(1),
  })
  .strict();

export function credentialsPath(home = resolveOpenTagHome()): string {
  return join(resolveOpenTagHomeLayout(home).config, CREDENTIALS_FILE_NAME);
}

export function readCredentials(home = resolveOpenTagHome()): Promise<StoredCredentials | undefined> {
  return readPrivateJson(home, credentialsPath(home), validateCredentials);
}

export async function writeCredentialsAtomically(
  credentials: StoredCredentials,
  home = resolveOpenTagHome(),
): Promise<void> {
  await writePrivateJson(home, credentialsPath(home), normalizeCredentials(credentials));
}

function validateCredentials(value: unknown): StoredCredentials {
  try {
    return normalizeCredentials(StoredCredentialsSchema.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The OpenTag server URL")) throw error;
    throw new Error("The OpenTag credentials file is invalid", { cause: error });
  }
}

function normalizeCredentials(value: unknown): StoredCredentials {
  const parsed = StoredCredentialsSchema.parse(value);
  return { ...parsed, serverUrl: normalizeServerUrl(parsed.serverUrl) };
}
