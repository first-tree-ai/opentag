import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCloudJournalScope,
  CLOUD_JOURNAL_MAX_ENTRIES,
  CloudJournal,
  CloudJournalError,
  type CloudJournalScope,
  computeCloudDeliveryInputHash,
} from "../runner/cloud-journal.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

function scopeFor(sessionId: string, overrides: Partial<CloudJournalScope> = {}): CloudJournalScope {
  return {
    sandboxId: randomUUID(),
    sessionId,
    environmentGeneration: 1,
    resourceName: "projects/p/locations/r/instances/ots-s-x-1",
    resourceUid: "uid-1",
    ...overrides,
  };
}

function reportFor(deliveryId: string, turnId: string, effects: "completed" | "not_started" = "completed") {
  const base = {
    type: "turn:report" as const,
    requestId: "6cae4d3b-2f9c-4a1e-9b2f-1a2b3c4d5e6f",
    deliveryId,
    turnId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    outcome: effects === "not_started" ? ("failed" as const) : ("completed" as const),
    executionEffects: effects,
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
    ...(effects === "not_started" ? { errorReason: "turn_timeout" as const } : {}),
  };
  return { ...base, resultHash: computeTurnResultHash(base) } satisfies TurnReportRequest;
}

describe("CloudJournal", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cloud-journal-test-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function received(
    input: {
      delivery?: ReturnType<typeof cloudDeliveryFixture>;
      scope?: CloudJournalScope;
      requestId?: string;
      turnId?: string;
      journal?: CloudJournal;
    } = {},
  ) {
    const journal = input.journal ?? (await CloudJournal.open(directory));
    const delivery = input.delivery ?? cloudDeliveryFixture();
    const scope = input.scope ?? scopeFor(delivery.sessionId);
    const entry = await journal.recordReceived({
      delivery,
      scope,
      deliveryId: delivery.deliveryId,
      requestId: input.requestId ?? delivery.requestId,
      turnId: input.turnId ?? "turn-1",
    });
    return { journal, delivery, scope, entry };
  }

  it("resets only entries that belong to the sealed assignment and fails closed on any other", async () => {
    const first = await received();
    const sameScope = await received({ journal: first.journal, scope: first.scope });
    await first.journal.resetScope(first.scope);
    expect(await first.journal.list()).toEqual([]);
    expect(sameScope.scope).toEqual(first.scope);

    const foreignDirectory = await mkdtemp(join(tmpdir(), "cloud-journal-foreign-"));
    try {
      const journal = await CloudJournal.open(foreignDirectory);
      const owned = await received({ journal });
      const foreign = await received({
        delivery: cloudDeliveryFixture({ sessionId: "session-2" }),
        scope: scopeFor("session-2", { resourceUid: "uid-2" }),
        journal,
      });
      // A foreign entry means the local state cannot be proven settled: nothing may be discarded.
      await expect(journal.resetScope(owned.scope)).rejects.toBeInstanceOf(CloudJournalError);
      expect((await journal.list()).map((entry) => entry.deliveryId).sort()).toEqual(
        [owned.delivery.deliveryId, foreign.delivery.deliveryId].sort(),
      );
    } finally {
      await rm(foreignDirectory, { recursive: true, force: true });
    }
  });

  it("persists the exact input, canonical input hash, and allocation scope across reopen", async () => {
    const { delivery, scope, entry } = await received();
    expect(entry.inputHash).toBe(computeCloudDeliveryInputHash(delivery));
    expect(entry.scope).toEqual(scope);
    const reopened = await CloudJournal.open(directory);
    const [persisted] = await reopened.list();
    expect(persisted?.delivery).toEqual(delivery);
    expect(persisted?.inputHash).toBe(computeCloudDeliveryInputHash(delivery));
    expect(persisted?.scope).toEqual(scope);
    // All five allocation identity fields define the owner, so any change fails closed.
    for (const field of ["sandboxId", "generation", "uid"] as const) {
      const changed: CloudJournalScope =
        field === "sandboxId"
          ? { ...scope, sandboxId: randomUUID() }
          : field === "generation"
            ? { ...scope, environmentGeneration: 2 }
            : { ...scope, resourceUid: "uid-2" };
      expect(() => assertCloudJournalScope(persisted as never, changed)).toThrowError(CloudJournalError);
    }
  });

  it("is idempotent for the exact duplicate and conflicts on changed inbox/digest/scope", async () => {
    const { journal, delivery, scope, entry } = await received();
    // Identical duplicate dispatch keeps the original turn id.
    const again = await journal.recordReceived({
      delivery,
      scope,
      deliveryId: delivery.deliveryId,
      requestId: delivery.requestId,
      turnId: "turn-other",
    });
    expect(again.turnId).toBe(entry.turnId);
    // Different dispatch identity for the same delivery is a conflict.
    await expect(
      journal.recordReceived({
        delivery,
        scope,
        deliveryId: delivery.deliveryId,
        requestId: "other-request",
        turnId: "turn-2",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Same ids, changed input is a conflict, never a second turn.
    await expect(
      journal.recordReceived({
        delivery: { ...delivery, content: { ...delivery.content, text: "changed" } },
        scope,
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        turnId: "turn-3",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Same ids under another allocation is a scope conflict.
    await expect(
      journal.recordReceived({
        delivery,
        scope: { ...scope, environmentGeneration: 2, resourceUid: "uid-2" },
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        turnId: "turn-4",
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(await journal.list()).toHaveLength(1);
  });

  it("serializes a concurrent burst of writes without a temp-file collision or lost update", async () => {
    const journal = await CloudJournal.open(directory);
    const scoped = Array.from({ length: 24 }, () => {
      const delivery = cloudDeliveryFixture();
      return { delivery, scope: scopeFor(delivery.sessionId) };
    });
    await Promise.all(
      scoped.map(({ delivery, scope }) =>
        journal.recordReceived({
          delivery,
          scope,
          deliveryId: delivery.deliveryId,
          requestId: delivery.requestId,
          turnId: randomUUID(),
        }),
      ),
    );
    // The same delivery concurrently: still exactly one durable entry with one turn id.
    const duplicate = scoped[0] as (typeof scoped)[number];
    const turnIds = new Set<string>();
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        const entry = await journal.recordReceived({
          delivery: duplicate.delivery,
          scope: duplicate.scope,
          deliveryId: duplicate.delivery.deliveryId,
          requestId: duplicate.delivery.requestId,
          turnId: randomUUID(),
        });
        turnIds.add(entry.turnId);
      }),
    );
    expect(turnIds.size).toBe(1);
    expect(await journal.list()).toHaveLength(24);
  });

  it("enforces the phase machine: received -> started -> reported, and received -> terminal not_started", async () => {
    const { journal, delivery, scope } = await received();
    await expect(
      journal.recordReport(delivery.deliveryId, scope, reportFor(delivery.deliveryId, "turn-1")),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    const notStarted = reportFor(delivery.deliveryId, "turn-1", "not_started");
    expect((await journal.recordReport(delivery.deliveryId, scope, notStarted)).phase).toBe("reported");
    // Reported is terminal: no start afterwards.
    await expect(journal.markStarted(delivery.deliveryId, scope)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    // The identical report is idempotent; a different result is a conflict.
    expect((await journal.recordReport(delivery.deliveryId, scope, notStarted)).phase).toBe("reported");
    const other = reportFor(delivery.deliveryId, "turn-1");
    await expect(journal.recordReport(delivery.deliveryId, scope, other)).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps the started boundary across reopen so a crash reports unknown, never a replay", async () => {
    const { journal, delivery, scope } = await received();
    expect((await journal.markStarted(delivery.deliveryId, scope)).phase).toBe("started");
    const reopened = await CloudJournal.open(directory);
    const [entry] = await reopened.list();
    expect(entry?.phase).toBe("started");
    expect(entry?.delivery).toEqual(delivery);
  });

  it("retires a pre-start rejection ONLY from received and never erases started/reported state", async () => {
    const { journal, delivery, scope } = await received();
    await journal.clearRejected(delivery.deliveryId, scope);
    expect(await journal.list()).toHaveLength(0);
    const started = await received({ journal, scope });
    await journal.markStarted(started.delivery.deliveryId, scope);
    await expect(journal.clearRejected(started.delivery.deliveryId, scope)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    expect(await journal.list()).toHaveLength(1);
  });

  it("clears only a matching durable ack and retains the report on conflict/stale/replay mismatch", async () => {
    const { journal, delivery, scope } = await received();
    await journal.markStarted(delivery.deliveryId, scope);
    const report = reportFor(delivery.deliveryId, "turn-1");
    await journal.recordReport(delivery.deliveryId, scope, report);
    // Replayed ack with a different result hash or status must NOT retire the durable report.
    await expect(
      journal.clearAcknowledged(delivery.deliveryId, scope, {
        resultHash: "0".repeat(64),
        status: "recorded",
        turnId: "turn-1",
      }),
    ).rejects.toMatchObject({ code: "ack_mismatch" });
    await expect(
      journal.clearAcknowledged(delivery.deliveryId, scope, {
        resultHash: report.resultHash,
        status: "conflict" as never,
        turnId: "turn-1",
      }),
    ).rejects.toMatchObject({ code: "ack_mismatch" });
    await expect(
      journal.clearAcknowledged(delivery.deliveryId, scope, {
        resultHash: report.resultHash,
        status: "recorded",
        turnId: "another-turn",
      }),
    ).rejects.toMatchObject({ code: "ack_mismatch" });
    expect(await journal.list()).toHaveLength(1);
    await journal.clearAcknowledged(delivery.deliveryId, scope, {
      resultHash: report.resultHash,
      status: "already_recorded",
      turnId: "turn-1",
    });
    expect(await journal.list()).toHaveLength(0);
  });

  it("enforces the entry cap atomically on write while still allowing retire and idempotent re-dispatch", async () => {
    const journal = await CloudJournal.open(directory);
    // Fill to capacity with durable entry-named files; the cap counts entries, not parsed reports.
    for (let index = 0; index < CLOUD_JOURNAL_MAX_ENTRIES - 1; index += 1) {
      await writeFile(join(directory, `filler-${index.toString().padStart(4, "0")}.json`), "{}\n");
    }
    const delivery = cloudDeliveryFixture();
    const scope = scopeFor(delivery.sessionId);
    const recorded = await journal.recordReceived({
      delivery,
      scope,
      deliveryId: delivery.deliveryId,
      requestId: delivery.requestId,
      turnId: "turn-1",
    });
    // At the cap, the idempotent duplicate still resolves to the original turn.
    const again = await journal.recordReceived({
      delivery,
      scope,
      deliveryId: delivery.deliveryId,
      requestId: delivery.requestId,
      turnId: "turn-2",
    });
    expect(again.turnId).toBe(recorded.turnId);
    // A NEW dispatch is refused before it can exceed capacity.
    const other = cloudDeliveryFixture();
    const otherScope = scopeFor(other.sessionId);
    await expect(
      journal.recordReceived({
        delivery: other,
        scope: otherScope,
        deliveryId: other.deliveryId,
        requestId: other.requestId,
        turnId: "turn-3",
      }),
    ).rejects.toMatchObject({ code: "store_failed" });
    // Retiring a durable entry frees capacity again.
    await journal.clearRejected(delivery.deliveryId, scope);
    await expect(
      journal.recordReceived({
        delivery: other,
        scope: otherScope,
        deliveryId: other.deliveryId,
        requestId: other.requestId,
        turnId: "turn-3",
      }),
    ).resolves.toMatchObject({ phase: "received" });
  });

  it("fails visibly on a corrupt journal file instead of skipping it", async () => {
    const { delivery } = await received();
    await writeFile(join(directory, `${delivery.deliveryId}.json`), "{not-json", "utf8");
    const reopened = await CloudJournal.open(directory);
    await expect(reopened.list()).rejects.toMatchObject({ code: "store_failed" });
    await expect(reopened.read(delivery.deliveryId)).rejects.toMatchObject({ code: "store_failed" });
  });

  it("fails visibly when a reopened entry has an unreadable scope", async () => {
    const { delivery } = await received();
    await writeFile(
      join(directory, `${delivery.deliveryId}.json`),
      JSON.stringify({
        version: 2,
        delivery,
        inputHash: computeCloudDeliveryInputHash(delivery),
        scope: { sandboxId: "only" },
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        turnId: "turn-1",
        phase: "received",
      }),
      "utf8",
    );
    const reopened = await CloudJournal.open(directory);
    await expect(reopened.list()).rejects.toMatchObject({ code: "store_failed" });
  });
});
