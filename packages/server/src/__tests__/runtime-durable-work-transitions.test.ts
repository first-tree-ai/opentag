import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { computeTurnResultHash, type RuntimeDurableWorkRecord, RuntimeDurableWorkStatusSchema } from "@opentag/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { computers, users } from "../db/schema/index.js";
import {
  PostgresRuntimeDurableWorkStore,
  RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS,
  RuntimeDurableWorkTransitionError,
} from "../runtime/runtime-durable-work-store.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const contract = z
  .array(
    z.object({
      from: RuntimeDurableWorkStatusSchema,
      to: RuntimeDurableWorkStatusSchema,
      writer: z.string().min(1),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../../scripts/fixtures/runtime-durable-work-transitions.json", import.meta.url),
        "utf8",
      ),
    ),
  );

type TransitionTable = Record<RuntimeDurableWorkRecord["status"], readonly RuntimeDurableWorkRecord["status"][]>;

function missingEdges(table: TransitionTable): string[] {
  return contract.filter(({ from, to }) => !table[from].includes(to)).map(({ from, to }) => `${from} -> ${to}`);
}

describe("Client durable-work transition contract", () => {
  let unit: UnitDatabase;
  let computerId: string;

  beforeAll(async () => {
    unit = await createUnitDatabase();
  }, 60_000);
  afterAll(async () => {
    await unit?.close();
  });
  beforeEach(async () => {
    await unit.reset();
    const accountId = randomUUID();
    computerId = randomUUID();
    await unit.database.insert(users).values({ id: accountId, email: `${accountId}@example.com`, displayName: "Test" });
    await unit.database.insert(computers).values({
      id: computerId,
      ownerAccountId: accountId,
      currentInstallationId: randomUUID(),
      displayName: "Test Computer",
      platform: "linux",
      arch: "x86_64",
      clientVersion: "1.0.0",
    });
  });

  it("covers every declared edge and detects removal of any single edge", () => {
    expect(missingEdges(RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS)).toEqual([]);
    const declared = Object.entries(RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS)
      .flatMap(([from, targets]) => targets.map((to) => `${from} -> ${to}`))
      .sort();
    expect(declared).toEqual(contract.map(({ from, to }) => `${from} -> ${to}`).sort());
    for (const { from, to } of contract) {
      const mutant = {
        ...RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS,
        [from]: (RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS[from] as readonly string[]).filter((target) => target !== to),
      } as TransitionTable;
      expect(missingEdges(mutant)).toContain(`${from} -> ${to}`);
    }
  });

  it.each(contract)("persists $from -> $to: $writer", async ({ from, to }) => {
    const store = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 100 });
    const record = reportRecord(from);
    await store.write(computerId, record);
    await expect(store.write(computerId, { ...record, status: to, updatedAt: 101 })).resolves.toBeUndefined();
    await expect(store.list(computerId, "turn-report")).resolves.toMatchObject({
      items: [{ key: record.key, status: to, updatedAt: 101 }],
    });
  });

  it.each(RuntimeDurableWorkStatusSchema.options.filter((status) => status !== "succeeded"))(
    "keeps succeeded absorbing when a newer writer requests %s",
    async (status) => {
      const store = new PostgresRuntimeDurableWorkStore(unit.database, { now: () => 100 });
      const record = reportRecord("succeeded");
      await store.write(computerId, record);
      await expect(store.write(computerId, { ...record, status, updatedAt: 101 })).rejects.toBeInstanceOf(
        RuntimeDurableWorkTransitionError,
      );
      await expect(store.list(computerId, "turn-report")).resolves.toMatchObject({
        items: [{ status: "succeeded", updatedAt: 100 }],
      });
    },
  );
});

function reportRecord(status: RuntimeDurableWorkRecord["status"]): RuntimeDurableWorkRecord {
  const input = {
    deliveryId: "delivery",
    turnId: "turn",
    sessionId: "session",
    agentId: "agent",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return {
    key: input.turnId,
    kind: "turn-report",
    status,
    acceptedAt: 100,
    updatedAt: 100,
    attempts: 0,
    payload: { type: "turn:report", requestId: randomUUID(), ...input, resultHash: computeTurnResultHash(input) },
  };
}
