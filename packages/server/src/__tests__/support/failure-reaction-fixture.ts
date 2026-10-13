import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImFailureReactionStore } from "../../services/im/im-failure-reaction-store.js";
import { ImFailureReactionWorker } from "../../services/im/im-failure-reaction-worker.js";
import type { ImProviderAdapter } from "../../services/im-bindings/provider-adapter.js";
import { createSlackWorkingFixture } from "./slack-working-fixture.js";

export async function createFailureReactionFixture(database: DatabaseClient, now: () => Date) {
  const h = await createSlackWorkingFixture(database, new ApplicationCipher(Buffer.alloc(32, 11)), now);
  const store = new ImFailureReactionStore(database, now);
  const setFailureReaction = vi.fn(
    async (_input: { channelId: string; externalMessageId: string; failed: boolean }) => undefined,
  );
  const warn = vi.fn<(fields: object, message: string) => void>();
  const adapter = {
    provider: "slack" as const,
    normalizeInbound: vi.fn<ImProviderAdapter<unknown>["normalizeInbound"]>(),
    validateBinding: vi.fn<ImProviderAdapter<unknown>["validateBinding"]>(),
    fetchResource: vi.fn<ImProviderAdapter<unknown>["fetchResource"]>(),
    setFailureReaction,
  };
  const worker = new ImFailureReactionWorker({ store, resolveAdapter: async () => adapter, logger: { warn } });
  async function report(frame: Awaited<ReturnType<typeof h.delivery>>["frame"], outcome: TurnReportRequest["outcome"]) {
    const { sequence: _sequence, phase: _phase, ...fields } = frame;
    const report: TurnReportRequest = {
      ...fields,
      type: "turn:report",
      outcome,
      executionEffects: outcome === "completed" ? "completed" : "may_have_occurred",
      traceSummary: { lastSequence: 1, droppedEvents: 0 },
      resultHash: "0".repeat(64),
      ...(outcome === "completed" ? {} : { errorReason: "provider_failed" as const }),
    };
    // Activity-only fields are deliberately absent from a report persisted by the real owner.
    const persisted = report;
    persisted.resultHash = computeTurnResultHash(persisted);
    await database
      .update(imMessageDeliveries)
      .set({
        dispatchPayload: null,
        turnReport: persisted,
        resultHash: persisted.resultHash,
        reportedAt: now(),
      })
      .where(eq(imMessageDeliveries.id, frame.deliveryId));
  }
  return { ...h, store, worker, adapter, setFailureReaction, warn, report };
}
