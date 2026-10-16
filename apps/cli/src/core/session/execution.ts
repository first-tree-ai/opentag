import { type FileHandle, open } from "node:fs/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER = "# opentag-execution: ";

/** Local providers persist across turns. Read only the current file marker, never evaluate its shell. */
export async function currentSessionExecutionId(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = environment.OPENTAG_PROVIDER_ENV_FILE;
  if (!path) return validId(environment.OPENTAG_EXECUTION_ID);
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The OpenTag execution context is unavailable", { cause: error });
  }
  try {
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    // Missing/malformed current material must not revive the stale process environment.
    return line.startsWith(MARKER) ? validId(line.slice(MARKER.length)) : undefined;
  } finally {
    await file.close();
  }
}

function validId(value: string | undefined): string | undefined {
  return value && UUID.test(value) ? value : undefined;
}
