import { join } from "node:path";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

export interface MachineComputerCredential {
  workspaceComputerId: string;
  computerId: string;
  machineToken: string;
  serverUrl: string;
}

export interface StoredMachineCredentials {
  version: 2;
  computer: MachineComputerCredential;
}

export const MACHINE_CREDENTIALS_FILE_NAME = "computer-credentials.json";

export function machineCredentialsPath(home = resolveOpenTagHome()): string {
  return join(resolveOpenTagHomeLayout(home).config, MACHINE_CREDENTIALS_FILE_NAME);
}

export function readMachineCredentials(home = resolveOpenTagHome()): Promise<StoredMachineCredentials | undefined> {
  return readPrivateJson(home, machineCredentialsPath(home), validateMachineCredentials);
}

/**
 * Strict, read-only projection for diagnostics. Unlike the runtime reader, this rejects the whole
 * file when any stored Computer credential is unusable, so corruption cannot be reported as a healthy
 * partial configuration.
 */
export function readMachineCredentialsStrict(
  home = resolveOpenTagHome(),
): Promise<StoredMachineCredentials | undefined> {
  return readPrivateJson(home, machineCredentialsPath(home), checkMachineCredentialsStrict);
}

/** Rejects rather than throwing synchronously, so a caller handling the returned promise sees the refusal. */
export async function writeMachineCredentialsAtomically(
  credentials: StoredMachineCredentials,
  home = resolveOpenTagHome(),
): Promise<void> {
  const checked = checkMachineCredentialsToWrite(credentials);
  await writePrivateJson(home, machineCredentialsPath(home), checked);
}

export type BoundAccountComputerResolution =
  | { status: "disconnected" }
  | { status: "bound"; credential: MachineComputerCredential };

/** One canonical home binds at most one Account Computer. */
export function resolveBoundAccountComputer(
  credentials: StoredMachineCredentials | undefined,
): BoundAccountComputerResolution {
  if (!credentials) return { status: "disconnected" };
  return { status: "bound", credential: credentials.computer };
}

export async function storeBoundAccountComputer(
  credential: MachineComputerCredential,
  home = resolveOpenTagHome(),
): Promise<StoredMachineCredentials> {
  const next: StoredMachineCredentials = { version: 2, computer: { ...credential } };
  await writeMachineCredentialsAtomically(next, home);
  return next;
}

function validateMachineCredentials(value: unknown): StoredMachineCredentials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 2) {
    throw new Error("The OpenTag Computer credentials file uses an unsupported format; reconnect this Computer");
  }
  const computer = readComputerEntry(record.computer);
  return computer ? { version: 2, computer } : undefined;
}

function checkMachineCredentialsToWrite(value: StoredMachineCredentials): StoredMachineCredentials {
  return checkMachineCredentialsStrict(value, "Refusing to write");
}

function checkMachineCredentialsStrict(
  value: unknown,
  failurePrefix = "The stored OpenTag Computer credentials contain",
): StoredMachineCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The OpenTag Computer credentials file is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 2) {
    throw new Error("The OpenTag Computer credentials file uses an unsupported format; reconnect this Computer");
  }
  const computer = readComputerEntry(record.computer);
  if (!computer) {
    throw new Error(`${failurePrefix} an unusable OpenTag Computer credential`);
  }
  return { version: 2, computer };
}

function readComputerEntry(value: unknown): MachineComputerCredential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    !isUuid(entry.workspaceComputerId) ||
    !isUuid(entry.computerId) ||
    typeof entry.machineToken !== "string" ||
    !entry.machineToken.startsWith("otmc_") ||
    typeof entry.serverUrl !== "string"
  ) {
    return undefined;
  }
  return {
    workspaceComputerId: entry.workspaceComputerId,
    computerId: entry.computerId,
    machineToken: entry.machineToken,
    serverUrl: entry.serverUrl,
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
