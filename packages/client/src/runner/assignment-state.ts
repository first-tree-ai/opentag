import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Trusted-parent assignment marker for one physical Runner Instance. Cloud Run container config is
 * immutable, so after an ownership transfer the SAME process is asked to serve a different
 * Session. The marker records which assignment currently owns the local workspace/journal and
 * whether its workspace was successfully sealed.
 *
 * Rebind discipline:
 * - a marker that matches the welcomed assignment keeps all local unsaved bytes;
 * - a marker for another assignment may be discarded ONLY when it is sealed, because a sealed
 *   assignment has no unsettled durable work;
 * - an unsealed (or unreadable) marker fails closed: the Runner never restores another Session's
 *   archive over state that might still hold unsaved work.
 */

const ASSIGNMENT_FILE = "assignment.json";

export interface RunnerAssignment {
  sandboxId: string;
  sessionId: string;
  environmentGeneration: number;
  resourceName: string;
  resourceUid: string;
  sealed: boolean;
}

function parseAssignment(raw: string): RunnerAssignment {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Runner assignment marker is not valid JSON");
  }
  if (typeof value !== "object" || value === null) throw new Error("The Runner assignment marker is not an object");
  const record = value as Record<string, unknown>;
  if (
    typeof record.sandboxId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.environmentGeneration !== "number" ||
    !Number.isSafeInteger(record.environmentGeneration) ||
    record.environmentGeneration < 0 ||
    typeof record.resourceName !== "string" ||
    typeof record.resourceUid !== "string" ||
    typeof record.sealed !== "boolean"
  ) {
    throw new Error("The Runner assignment marker has an unsupported shape");
  }
  return {
    sandboxId: record.sandboxId,
    sessionId: record.sessionId,
    environmentGeneration: record.environmentGeneration,
    resourceName: record.resourceName,
    resourceUid: record.resourceUid,
    sealed: record.sealed,
  };
}

export function assignmentsMatch(
  assignment: RunnerAssignment,
  scope: { sandboxId: string; environmentGeneration: number; resourceName: string },
): boolean {
  return (
    assignment.sandboxId === scope.sandboxId &&
    assignment.environmentGeneration === scope.environmentGeneration &&
    assignment.resourceName === scope.resourceName
  );
}

/** Read the marker; `undefined` means no prior assignment on this trusted state root. */
export async function readRunnerAssignment(stateDir: string): Promise<RunnerAssignment | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir, ASSIGNMENT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The Runner assignment marker could not be read");
  }
  return parseAssignment(raw);
}

/** Atomic marker write (temp + rename) so a crash never leaves a half-written assignment. */
export async function writeRunnerAssignment(stateDir: string, assignment: RunnerAssignment): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = join(stateDir, ASSIGNMENT_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(assignment)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error("The Runner assignment marker was not durable");
  }
}

/**
 * True when local state exists without a usable assignment marker: the Runner cannot prove the
 * old workspace was sealed, so the new assignment must fail closed rather than execute over it.
 */
export async function hasUnmarkedAssignmentState(paths: {
  workspace: string;
  journalDir: string;
  privateTurnRoot: string;
  publicRoot: string;
}): Promise<boolean> {
  return (
    (await directoryHasEntries(paths.workspace)) ||
    (await directoryHasEntries(paths.journalDir)) ||
    (await directoryHasEntries(paths.privateTurnRoot)) ||
    (await directoryHasEntries(paths.publicRoot))
  );
}

async function directoryHasEntries(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("The Runner local assignment state could not be inspected");
  }
}
