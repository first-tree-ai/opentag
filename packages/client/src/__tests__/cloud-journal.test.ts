import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTurnResultHash, type SessionMessageDeliveryRequest, type TurnReportRequest } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCloudJournalScope,
  CLOUD_JOURNAL_MAX_ENTRIES,
  CloudJournal,
  type CloudJournalDeliveryEntry,
  type CloudJournalEntry,
  CloudJournalError,
  type CloudJournalScope,
  cloudJournalEntryKey,
  computeCloudDeliveryInputHash,
} from "../runner/cloud-journal.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

function asDelivery(entry: CloudJournalEntry | undefined): CloudJournalDeliveryEntry {
  if (entry?.kind !== "delivery") throw new Error("expected a delivery journal entry");
  return entry;
}

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

function sessionFixture(overrides: Partial<SessionMessageDeliveryRequest> = {}): SessionMessageDeliveryRequest {
  const runtime = cloudDeliveryFixture().runtime;
  const messageId = overrides.messageId ?? randomUUID();
  return {
    type: "session:message:deliver",
    requestId: messageId,
    messageId,
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId: runtime.agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "child task" },
    runtime,
    ...overrides,
  };
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
      expect((await journal.list()).map((entry) => cloudJournalEntryKey(entry)).sort()).toEqual(
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
    expect(asDelivery(persisted).delivery).toEqual(delivery);
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
    expect(asDelivery(entry).delivery).toEqual(delivery);
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

  it("refuses a journal key that changed entry kind and enforces both idempotent transitions", async () => {
    const journal = await CloudJournal.open(directory);
    const message = sessionFixture();
    const scope = scopeFor(message.targetSessionId);
    await journal.recordSessionReceived({
      message,
      sessionKind: "internal",
      scope,
      requestId: message.requestId,
      turnId: "turn-s",
    });
    // The delivery API must refuse a key that names a Session entry, and vice versa.
    const delivery = cloudDeliveryFixture({ deliveryId: message.messageId });
    await expect(
      journal.recordReceived({
        delivery,
        scope: scopeFor(delivery.sessionId),
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        turnId: "turn-d",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // `markSessionStarted` is idempotent once started and refuses a reported entry.
    const startedFirst = await journal.markSessionStarted(message.messageId, scope);
    expect(await journal.markSessionStarted(message.messageId, scope)).toMatchObject({
      phase: startedFirst.phase,
      turnId: startedFirst.turnId,
    });
    await journal.recordSessionSettled(message.messageId, scope, "cancelled");
    await expect(journal.markSessionStarted(message.messageId, scope)).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("keeps a reported Session settlement idempotent and refuses a different one", async () => {
    const journal = await CloudJournal.open(directory);
    const message = sessionFixture();
    const scope = scopeFor(message.targetSessionId);
    await journal.recordSessionReceived({
      message,
      sessionKind: "internal",
      scope,
      requestId: message.requestId,
      turnId: "turn-s",
    });
    await journal.markSessionStarted(message.messageId, scope);
    const reported = await journal.recordSessionSettled(message.messageId, scope, "failed");
    // Repeating the SAME settlement is idempotent; a different one is a conflict.
    expect(await journal.recordSessionSettled(message.messageId, scope, "failed")).toMatchObject({
      settlement: { outcome: "failed" },
      turnId: reported.turnId,
    });
    await expect(journal.recordSessionSettled(message.messageId, scope, "cancelled")).rejects.toMatchObject({
      code: "conflict",
    });
    // A settlement ack for an unknown or never-started entry is refused.
    await expect(
      journal.clearSessionAcknowledged(randomUUID(), scope, {
        status: "recorded",
        turnId: "turn-s",
      }),
    ).rejects.toMatchObject({ code: "unknown_entry" });
  });

  it("refuses to replace or re-correlate a Session entry that already started", async () => {
    const journal = await CloudJournal.open(directory);
    const message = sessionFixture();
    const scope = scopeFor(message.targetSessionId);
    await journal.recordSessionReceived({
      message,
      sessionKind: "internal",
      scope,
      requestId: message.requestId,
      turnId: "turn-s",
    });
    await journal.markSessionStarted(message.messageId, scope);
    await expect(
      journal.replaceSessionReceived({
        message,
        sessionKind: "internal",
        scope,
        requestId: randomUUID(),
        turnId: "turn-new",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(journal.updateSessionRequestId(message.messageId, scope, randomUUID())).rejects.toMatchObject({
      code: "invalid_transition",
    });
    // Re-correlating to the SAME request id is a no-op that keeps the entry.
    expect(await journal.updateSessionRequestId(message.messageId, scope, message.requestId)).toMatchObject({
      phase: "started",
    });
    // Retiring a started entry as rejected is refused.
    await expect(journal.clearSessionRejected(message.messageId, scope)).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("refuses the shared-surface reads and unsafe journal paths", async () => {
    const journal = await CloudJournal.open(directory);
    const delivery = cloudDeliveryFixture();
    const scope = scopeFor(delivery.sessionId);
    // A missing entry and a wrong-kind entry both fail closed on the scoped delivery read.
    await expect(journal.markStarted(randomUUID(), scope)).rejects.toMatchObject({ code: "unknown_entry" });
    const message = sessionFixture({ messageId: delivery.deliveryId });
    await journal.recordSessionReceived({
      message,
      sessionKind: "internal",
      scope,
      requestId: message.requestId,
      turnId: "turn-s",
    });
    await expect(journal.markStarted(delivery.deliveryId, scope)).rejects.toMatchObject({ code: "unknown_entry" });
    await expect(journal.markSessionStarted(randomUUID(), scope)).rejects.toMatchObject({ code: "unknown_entry" });
    // An unsafe entry name that could escape the journal directory is refused on read.
    await writeFile(join(directory, "..escape.json"), "{}\n");
    await expect(journal.read("..escape")).rejects.toMatchObject({ code: "store_failed" });
    await expect(journal.read("../escape")).rejects.toMatchObject({ code: "store_failed" });
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

  describe("Session message entries", () => {
    it("journals received -> started -> reported and retires only on the exact settlement ack", async () => {
      const opened = await CloudJournal.open(directory);
      const message = sessionFixture();
      const scope = scopeFor(message.targetSessionId);
      const received = await opened.recordSessionReceived({
        message,
        sessionKind: "internal",
        scope,
        requestId: message.requestId,
        turnId: "turn-s",
      });
      expect(received).toMatchObject({ kind: "session-message", phase: "received", messageId: message.messageId });
      expect((await opened.markSessionStarted(message.messageId, scope)).phase).toBe("started");
      const reported = await opened.recordSessionSettled(message.messageId, scope, "completed");
      expect(reported).toMatchObject({ phase: "reported", settlement: { outcome: "completed" } });
      await expect(opened.recordSessionSettled(message.messageId, scope, "failed")).rejects.toMatchObject({
        code: "conflict",
      });
      const [persisted] = await (await CloudJournal.open(directory)).list();
      expect(persisted).toMatchObject({
        kind: "session-message",
        sessionKind: "internal",
        phase: "reported",
        settlement: { outcome: "completed" },
      });
      expect(persisted?.kind === "session-message" ? persisted.message.content : undefined).toEqual(message.content);
      await expect(
        opened.clearSessionAcknowledged(message.messageId, scope, { status: "recorded", turnId: "other" }),
      ).rejects.toMatchObject({ code: "ack_mismatch" });
      await opened.clearSessionAcknowledged(message.messageId, scope, { status: "recorded", turnId: "turn-s" });
      expect(await opened.list()).toEqual([]);
    });

    it("enforces the internal/visible outbox contract and refuses changed input under one dispatch", async () => {
      const opened = await CloudJournal.open(directory);
      const message = sessionFixture();
      const scope = scopeFor(message.targetSessionId);
      await expect(
        opened.recordSessionReceived({
          message,
          sessionKind: "internal",
          outboxContext: { provider: "feishu", sessionKind: "channel", chatId: "chat" },
          scope,
          requestId: message.requestId,
          turnId: "turn-s",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        opened.recordSessionReceived({
          message,
          sessionKind: "visible",
          scope,
          requestId: message.requestId,
          turnId: "turn-s",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      const first = await opened.recordSessionReceived({
        message,
        sessionKind: "internal",
        scope,
        requestId: message.requestId,
        turnId: "turn-s",
      });
      const replay = await opened.recordSessionReceived({
        message,
        sessionKind: "internal",
        scope,
        requestId: message.requestId,
        turnId: "turn-other",
      });
      expect(replay.turnId).toBe(first.turnId);
      await expect(
        opened.recordSessionReceived({
          message: { ...message, content: { kind: "text", text: "changed" } },
          sessionKind: "internal",
          scope,
          requestId: message.requestId,
          turnId: "turn-s",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("supersedes a received entry atomically, re-correlates retries, and preserves the old entry on failure", async () => {
      const opened = await CloudJournal.open(directory);
      const message = sessionFixture();
      const scope = scopeFor(message.targetSessionId);
      await opened.recordSessionReceived({
        message,
        sessionKind: "internal",
        scope,
        requestId: message.requestId,
        turnId: "turn-s",
      });

      // A same-input retry under a new attempt identity re-correlates the entry in place.
      const retryRequestId = randomUUID();
      const rekeyed = await opened.updateSessionRequestId(message.messageId, scope, retryRequestId);
      expect(rekeyed).toMatchObject({ requestId: retryRequestId, turnId: "turn-s", phase: "received" });
      await expect(opened.updateSessionRequestId(message.messageId, scope, retryRequestId)).resolves.toMatchObject({
        requestId: retryRequestId,
      });

      // A retry with changed input supersedes the received entry with a fresh Turn.
      const changed: SessionMessageDeliveryRequest = {
        ...message,
        requestId: randomUUID(),
        runtime: { ...message.runtime, instructions: { ...message.runtime.instructions, agent: "Changed." } },
      };
      const replaced = await opened.replaceSessionReceived({
        message: changed,
        sessionKind: "internal",
        scope,
        requestId: changed.requestId,
        turnId: "turn-new",
      });
      expect(replaced).toMatchObject({ requestId: changed.requestId, turnId: "turn-new", phase: "received" });
      const reopened = await CloudJournal.open(directory);
      const [persisted] = await reopened.list();
      expect(persisted).toMatchObject({
        kind: "session-message",
        requestId: changed.requestId,
        turnId: "turn-new",
        phase: "received",
      });

      // A started entry is execution evidence: never superseded and never re-correlated.
      const startedMessage = sessionFixture();
      await opened.recordSessionReceived({
        message: startedMessage,
        sessionKind: "internal",
        scope,
        requestId: startedMessage.requestId,
        turnId: "turn-s2",
      });
      await opened.markSessionStarted(startedMessage.messageId, scope);
      await expect(
        opened.replaceSessionReceived({
          message: { ...startedMessage, requestId: randomUUID() },
          sessionKind: "internal",
          scope,
          requestId: randomUUID(),
          turnId: "turn-x",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await expect(opened.updateSessionRequestId(startedMessage.messageId, scope, randomUUID())).rejects.toMatchObject({
        code: "invalid_transition",
      });

      // A failed replacement never erases custody: with the journal directory unwritable the
      // atomic write fails and the old received entry survives intact.
      const keptMessage = sessionFixture();
      await opened.recordSessionReceived({
        message: keptMessage,
        sessionKind: "internal",
        scope,
        requestId: keptMessage.requestId,
        turnId: "turn-s3",
      });
      await chmod(directory, 0o500);
      try {
        await expect(
          opened.replaceSessionReceived({
            message: {
              ...keptMessage,
              requestId: randomUUID(),
              runtime: { ...keptMessage.runtime, instructions: { ...keptMessage.runtime.instructions, agent: "New" } },
            },
            sessionKind: "internal",
            scope,
            requestId: randomUUID(),
            turnId: "turn-x",
          }),
        ).rejects.toMatchObject({ code: "store_failed" });
      } finally {
        await chmod(directory, 0o700);
      }
      expect(await opened.read(keptMessage.messageId)).toMatchObject({
        phase: "received",
        requestId: keptMessage.requestId,
        turnId: "turn-s3",
      });
    });

    it("never reports completion before the started boundary and still parses legacy v2 delivery files", async () => {
      const opened = await CloudJournal.open(directory);
      const message = sessionFixture();
      const scope = scopeFor(message.targetSessionId);
      await opened.recordSessionReceived({
        message,
        sessionKind: "internal",
        scope,
        requestId: message.requestId,
        turnId: "turn-s",
      });
      await expect(opened.recordSessionSettled(message.messageId, scope, "completed")).rejects.toMatchObject({
        code: "invalid_transition",
      });
      expect((await opened.recordSessionSettled(message.messageId, scope, "cancelled")).phase).toBe("reported");

      const delivery = cloudDeliveryFixture();
      const deliveryScope = scopeFor(delivery.sessionId);
      await opened.recordReceived({
        delivery,
        scope: deliveryScope,
        deliveryId: delivery.deliveryId,
        requestId: delivery.requestId,
        turnId: "turn-1",
      });
      // An E7 v2 file predates `kind`; it must still parse as an IM delivery after restart.
      const file = join(directory, `${delivery.deliveryId}.json`);
      const legacy = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      delete legacy.kind;
      await writeFile(file, JSON.stringify(legacy), "utf8");
      const entry = await (await CloudJournal.open(directory)).read(delivery.deliveryId);
      expect(entry?.kind).toBe("delivery");
      expect(entry?.phase).toBe("received");
    });
  });
});
