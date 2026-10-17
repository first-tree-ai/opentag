import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import type { DatabaseClient } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImFailureReactions } from "../../services/im/im-failure-reactions.js";
import type { ImProviderAdapter } from "../../services/im-bindings/provider-adapter.js";
import { createSlackWorkingFixture } from "./slack-working-fixture.js";

export async function createFailureReactionFixture(database: DatabaseClient, now: () => Date) {
  const h = await createSlackWorkingFixture(database, new ApplicationCipher(Buffer.alloc(32, 11)), now);
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
  const reactions = new ImFailureReactions({ database, resolveAdapter: async () => adapter, logger: { warn } });
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
    report.resultHash = computeTurnResultHash(report);
    await database
      .update(imMessageDeliveries)
      .set({
        dispatchPayload: null,
        turnReport: report,
        resultHash: report.resultHash,
        reportedAt: now(),
      })
      .where(eq(imMessageDeliveries.id, frame.deliveryId));
  }
  return { ...h, reactions, adapter, setFailureReaction, warn, report };
}
