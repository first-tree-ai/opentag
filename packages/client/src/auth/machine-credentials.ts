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

/** Rejects rather than throwing synchronously, so a caller handling the returned promise sees the refusal. */
export async function writeMachineCredentialsAtomically(
  credentials: StoredMachineCredentials,
  home = resolveOpenTagHome(),
): Promise<void> {
  const checked = checkMachineCredentialsToWrite(credentials);
  await writePrivateJson(home, machineCredentialsPath(home), checked);
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

/**
 * Reading and writing disagree on purpose. A file on disk may hold entries this Client cannot use, and
 * one of them must not strand every other enrollment on the host, so unusable entries are dropped.
 */
function validateMachineCredentials(value: unknown): StoredMachineCredentials {
  const enrollmentIds = new Set<string>();
  const enrollments: MachineEnrollmentCredential[] = [];
  for (const entry of readCredentialsEnvelope(value)) {
    const credential = readEnrollmentEntry(entry);
    if (!credential || enrollmentIds.has(credential.workspaceComputerId)) continue;
    enrollmentIds.add(credential.workspaceComputerId);
    enrollments.push(credential);
  }
  return { version: 1, enrollments };
}

/**
 * A write is the opposite case: the caller is asking for specific credentials to be persisted, so
 * dropping one would report success while losing an enrollment, and the next read would discard the
 * bytes just written. Unusable input is rejected, and the validated projection is what reaches disk.
 */
function checkMachineCredentialsToWrite(value: StoredMachineCredentials): StoredMachineCredentials {
  const enrollmentIds = new Set<string>();
  const enrollments: MachineEnrollmentCredential[] = [];
  for (const [index, entry] of readCredentialsEnvelope(value).entries()) {
    const credential = readEnrollmentEntry(entry);
    if (!credential) {
      throw new Error(`Refusing to write an unusable OpenTag Computer credential (entry ${index})`);
    }
    if (enrollmentIds.has(credential.workspaceComputerId)) {
      throw new Error(`Refusing to write a duplicate OpenTag Computer enrollment (entry ${index})`);
    }
    enrollmentIds.add(credential.workspaceComputerId);
    enrollments.push(credential);
  }
  return { version: 1, enrollments };
}

function readCredentialsEnvelope(value: unknown): readonly unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The OpenTag Computer credentials file is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.enrollments)) {
    throw new Error("The OpenTag Computer credentials file is invalid");
  }
  return record.enrollments;
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
