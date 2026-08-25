import { join } from "node:path";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

export interface MachineEnrollmentCredential {
  workspaceComputerId: string;
  workspaceId: string;
  computerId: string;
  machineToken: string;
  serverUrl: string;
}

export interface StoredMachineCredentials {
  version: 1;
  enrollments: MachineEnrollmentCredential[];
}

export const MACHINE_CREDENTIALS_FILE_NAME = "computer-credentials.json";

export function machineCredentialsPath(home = resolveOpenTagHome()): string {
  return join(resolveOpenTagHomeLayout(home).config, MACHINE_CREDENTIALS_FILE_NAME);
}

export function readMachineCredentials(home = resolveOpenTagHome()): Promise<StoredMachineCredentials | undefined> {
  return readPrivateJson(home, machineCredentialsPath(home), validateMachineCredentials);
}

export function writeMachineCredentialsAtomically(
  credentials: StoredMachineCredentials,
  home = resolveOpenTagHome(),
): Promise<void> {
  validateMachineCredentials(credentials);
  return writePrivateJson(home, machineCredentialsPath(home), credentials);
}

export async function storeMachineEnrollmentCredential(
  credential: MachineEnrollmentCredential,
  home = resolveOpenTagHome(),
): Promise<StoredMachineCredentials> {
  const current = (await readMachineCredentials(home)) ?? { version: 1 as const, enrollments: [] };
  const enrollments = current.enrollments.filter(
    (entry) =>
      entry.workspaceComputerId !== credential.workspaceComputerId && entry.workspaceId !== credential.workspaceId,
  );
  enrollments.push({ ...credential });
  enrollments.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  const next: StoredMachineCredentials = { version: 1, enrollments };
  await writeMachineCredentialsAtomically(next, home);
  return next;
}

function validateMachineCredentials(value: unknown): StoredMachineCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The OpenTag Computer credentials file is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.enrollments)) {
    throw new Error("The OpenTag Computer credentials file is invalid");
  }
  const workspaceIds = new Set<string>();
  const enrollmentIds = new Set<string>();
  for (const value of record.enrollments) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The OpenTag Computer credentials file is invalid");
    }
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 5 ||
      !isUuid(entry.workspaceComputerId) ||
      !isUuid(entry.workspaceId) ||
      !isUuid(entry.computerId) ||
      typeof entry.machineToken !== "string" ||
      !entry.machineToken.startsWith("otmc_") ||
      typeof entry.serverUrl !== "string" ||
      workspaceIds.has(entry.workspaceId) ||
      enrollmentIds.has(entry.workspaceComputerId)
    ) {
      throw new Error("The OpenTag Computer credentials file is invalid");
    }
    workspaceIds.add(entry.workspaceId);
    enrollmentIds.add(entry.workspaceComputerId);
  }
  return record as unknown as StoredMachineCredentials;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
