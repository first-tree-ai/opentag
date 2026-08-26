import { join } from "node:path";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

export interface MachineEnrollmentCredential {
  workspaceComputerId: string;
  /**
   * @deprecated The enrollment identifies its own scope. Optional so credentials written before and
   * after the ownership cutover are both readable by the same Client.
   */
  workspaceId?: string;
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
  // The enrollment id is the identity; the legacy scope is only compared when both entries carry one,
  // so a re-enrolment that arrives without it still replaces the credential it supersedes.
  const enrollments = current.enrollments.filter(
    (entry) =>
      entry.workspaceComputerId !== credential.workspaceComputerId &&
      !(entry.workspaceId !== undefined && entry.workspaceId === credential.workspaceId),
  );
  enrollments.push({ ...credential });
  enrollments.sort((left, right) => left.workspaceComputerId.localeCompare(right.workspaceComputerId));
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
  // One unreadable entry must not strand every other enrollment on this host, so entries are validated
  // individually and unusable ones are dropped rather than failing the whole file.
  const enrollmentIds = new Set<string>();
  const enrollments: MachineEnrollmentCredential[] = [];
  for (const entry of record.enrollments) {
    const credential = readEnrollmentEntry(entry);
    if (!credential || enrollmentIds.has(credential.workspaceComputerId)) continue;
    enrollmentIds.add(credential.workspaceComputerId);
    enrollments.push(credential);
  }
  return { version: 1, enrollments };
}

/** Accepts an entry written before or after the ownership cutover; returns undefined when unusable. */
function readEnrollmentEntry(value: unknown): MachineEnrollmentCredential | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    !isUuid(entry.workspaceComputerId) ||
    !isUuid(entry.computerId) ||
    typeof entry.machineToken !== "string" ||
    !entry.machineToken.startsWith("otmc_") ||
    typeof entry.serverUrl !== "string" ||
    (entry.workspaceId !== undefined && !isUuid(entry.workspaceId))
  ) {
    return undefined;
  }
  return {
    workspaceComputerId: entry.workspaceComputerId,
    computerId: entry.computerId,
    machineToken: entry.machineToken,
    serverUrl: entry.serverUrl,
    ...(entry.workspaceId === undefined ? {} : { workspaceId: entry.workspaceId }),
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
