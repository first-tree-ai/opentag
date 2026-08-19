import { randomUUID } from "node:crypto";
import {
  acquireProcessFileLease,
  inspectProcessFileLease,
  type ProcessFileLease,
  ProcessLeaseBusyError,
  type ProcessLeaseInspection,
  ProcessLeaseMalformedError,
  ProcessLeaseUnverifiableError,
} from "./process-lease.js";

export interface DaemonOwner {
  home: string;
  instanceId: string;
  ownerId: string;
  pid: number;
  processStartId: string;
  startedAt: string;
}

export interface DaemonOwnerLease {
  owner: DaemonOwner;
  release(): Promise<void>;
}

export class DaemonOwnerStartupError extends Error {
  override readonly name = "DaemonOwnerStartupError";

  constructor(
    readonly code: "BUSY" | "MALFORMED" | "UNVERIFIABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const OWNER_FILE_NAME = "daemon-owner.json";

export async function acquireDaemonOwner(home: string, instanceId: string): Promise<DaemonOwnerLease> {
  let lease: ProcessFileLease<DaemonOwner>;
  try {
    lease = await acquireProcessFileLease(home, {
      createRecord: (processStartId) => ({
        home,
        instanceId,
        ownerId: randomUUID(),
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName: OWNER_FILE_NAME,
      getId: (owner) => owner.ownerId,
      parseRecord: parseOwner,
    });
  } catch (error) {
    if (error instanceof ProcessLeaseBusyError) {
      throw new DaemonOwnerStartupError(
        "BUSY",
        `An OpenTag daemon is already running for this home (pid ${error.pid})`,
        {
          cause: error,
        },
      );
    }
    throw normalizeOwnerError(error);
  }

  return {
    owner: lease.record,
    release: lease.release,
  };
}

export async function inspectDaemonOwner(home: string): Promise<ProcessLeaseInspection<DaemonOwner>> {
  try {
    return await inspectProcessFileLease(home, {
      fileName: OWNER_FILE_NAME,
      getId: (owner) => owner.ownerId,
      parseRecord: parseOwner,
    });
  } catch (error) {
    throw normalizeOwnerError(error);
  }
}

function parseOwner(value: unknown): DaemonOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The daemon owner record is malformed; refusing automatic recovery");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.home !== "string" ||
    typeof record.instanceId !== "string" ||
    typeof record.ownerId !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.processStartId !== "string" ||
    record.processStartId.length === 0 ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error("The daemon owner record is malformed; refusing automatic recovery");
  }
  return record as unknown as DaemonOwner;
}

function normalizeOwnerError(error: unknown): Error {
  if (error instanceof ProcessLeaseMalformedError) {
    return new DaemonOwnerStartupError(
      "MALFORMED",
      "The daemon owner record is malformed; refusing automatic recovery",
      {
        cause: error,
      },
    );
  }
  if (error instanceof ProcessLeaseUnverifiableError) {
    return new DaemonOwnerStartupError("UNVERIFIABLE", error.message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
