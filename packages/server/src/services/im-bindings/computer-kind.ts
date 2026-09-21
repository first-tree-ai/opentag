import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";

/** Exact Computer kind; `undefined` for unknown rows so Cloud can never be mistaken for Local. */
export async function computerKindFor(
  computerId: string,
  database: DatabaseClient,
): Promise<"local" | "cloud" | undefined> {
  const [row] = await database
    .select({ kind: computers.kind })
    .from(computers)
    .where(eq(computers.id, computerId))
    .limit(1);
  return row?.kind;
}

/** Legacy raw grants are a Local-only compatibility path; Cloud never receives raw material. */
export async function localRawGrantAllowed(computerId: string, database: DatabaseClient): Promise<boolean> {
  return (await computerKindFor(computerId, database)) === "local";
}
