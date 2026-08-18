import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

export interface StoredCredentials {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  serverUrl: string;
}

export const CREDENTIALS_FILE_NAME = "credentials.json";

export function resolveOpenTagHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OPENTAG_HOME ? resolve(environment.OPENTAG_HOME) : join(homedir(), ".opentag");
}

export function credentialsPath(home = resolveOpenTagHome()): string {
  return join(home, CREDENTIALS_FILE_NAME);
}

export function readCredentials(home = resolveOpenTagHome()): Promise<StoredCredentials | undefined> {
  return readPrivateJson(home, CREDENTIALS_FILE_NAME, validateCredentials);
}

export function writeCredentialsAtomically(credentials: StoredCredentials, home = resolveOpenTagHome()): Promise<void> {
  validateCredentials(credentials);
  return writePrivateJson(home, CREDENTIALS_FILE_NAME, credentials);
}

function validateCredentials(value: unknown): StoredCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The OpenTag credentials file is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    typeof record.accessToken !== "string" ||
    typeof record.accessTokenExpiresAt !== "string" ||
    Number.isNaN(Date.parse(record.accessTokenExpiresAt)) ||
    typeof record.refreshToken !== "string" ||
    typeof record.serverUrl !== "string"
  ) {
    throw new Error("The OpenTag credentials file is invalid");
  }
  return record as unknown as StoredCredentials;
}
