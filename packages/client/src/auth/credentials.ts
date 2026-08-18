import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

export async function readCredentials(home = resolveOpenTagHome()): Promise<StoredCredentials | undefined> {
  const path = credentialsPath(home);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(content);
  if (!isStoredCredentials(parsed)) {
    throw new Error("The OpenTag credentials file is invalid");
  }
  return parsed;
}

export async function writeCredentialsAtomically(
  credentials: StoredCredentials,
  home = resolveOpenTagHome(),
): Promise<void> {
  await mkdir(home, { mode: 0o700, recursive: true });
  const homeStatus = await lstat(home);
  if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink()) {
    throw new Error("The OpenTag home must be a real directory");
  }
  await chmod(home, 0o700);
  const destination = credentialsPath(home);
  const temporary = join(dirname(destination), `.${CREDENTIALS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(credentials, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    typeof record.accessToken === "string" &&
    typeof record.accessTokenExpiresAt === "string" &&
    !Number.isNaN(Date.parse(record.accessTokenExpiresAt)) &&
    typeof record.refreshToken === "string" &&
    typeof record.serverUrl === "string"
  );
}
