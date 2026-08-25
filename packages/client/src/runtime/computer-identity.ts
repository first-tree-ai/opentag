import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json-file.js";

export interface ComputerIdentity {
  version: 2;
  computerId: string;
  serverUrl: string;
}

export const COMPUTER_IDENTITY_FILE_NAME = "computer.json";

export function computerIdentityPath(home: string): string {
  return join(resolveOpenTagHomeLayout(home).config, COMPUTER_IDENTITY_FILE_NAME);
}

export function readComputerIdentity(home: string): Promise<ComputerIdentity | undefined> {
  return readPrivateJson(home, computerIdentityPath(home), validateIdentity);
}

export async function resolveComputerIdentity(home: string, serverUrl: string): Promise<ComputerIdentity> {
  const existing = await readComputerIdentity(home);
  if (existing) {
    if (existing.serverUrl !== serverUrl) {
      throw new Error("This OpenTag home is bound to another server; choose a different OPENTAG_HOME");
    }
    await writePrivateJson(home, computerIdentityPath(home), existing);
    return existing;
  }
  const identity: ComputerIdentity = { version: 2, computerId: randomUUID(), serverUrl };
  await writePrivateJson(home, computerIdentityPath(home), identity);
  return identity;
}

function validateIdentity(value: unknown): ComputerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The OpenTag computer identity file is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    ![1, 2].includes(record.version as number) ||
    typeof record.computerId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.computerId) ||
    typeof record.serverUrl !== "string" ||
    (record.version === 1 && (Object.keys(record).length !== 4 || typeof record.userId !== "string")) ||
    (record.version === 2 && Object.keys(record).length !== 3)
  ) {
    throw new Error("The OpenTag computer identity file is invalid");
  }
  return { version: 2, computerId: record.computerId, serverUrl: record.serverUrl } as ComputerIdentity;
}
