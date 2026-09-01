import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import {
  FeishuInboundReceiptError,
  FeishuInboundReceiptStore,
} from "../services/im-bindings/feishu/inbound-receipt-store.js";

interface ReceiptRow {
  id: string;
  imBindingId: string;
  credentialGeneration: number;
  eventId: string;
  status: "processing" | "processed" | "failed";
  receivedAt?: Date;
  processedAt?: Date;
  lastErrorCode?: string | null;
  lastErrorAt?: Date | null;
}

function createReceiptDatabase(initial: ReceiptRow[] = []) {
  const rows = [...initial];
  let nextId = rows.length + 1;
  const database = {
    transaction: async (callback: (transaction: unknown) => unknown) => callback(database),
    insert: vi.fn(() => ({
      values: vi.fn((values: Omit<ReceiptRow, "id">) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            const duplicate = rows.some(
              (row) => row.imBindingId === values.imBindingId && row.eventId === values.eventId,
            );
            if (duplicate) return [];
            const created: ReceiptRow = { ...values, id: `receipt-${nextId++}` };
            rows.push(created);
            return [{ id: created.id, status: created.status }];
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const row = rows[0];
            return row ? [{ id: row.id, status: row.status }] : [];
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Partial<ReceiptRow>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            const row = rows[0];
            if (!row) return [];
            Object.assign(row, values);
            return [{ id: row.id, bindingId: row.imBindingId, eventId: row.eventId }];
          }),
        })),
      })),
    })),
  };
  return { database: database as unknown as DatabaseClient, rows };
}

const claimInput = {
  bindingId: "binding-1",
  credentialGeneration: 3,
  eventId: "event-1",
};

describe("FeishuInboundReceiptStore", () => {
  it("rejects invalid event IDs and generations before touching the database", async () => {
    const fake = createReceiptDatabase();
    const store = new FeishuInboundReceiptStore(fake.database);

    await expect(store.claim({ ...claimInput, eventId: "" })).rejects.toMatchObject({
      code: "FEISHU_RECEIPT_EVENT_ID_INVALID",
    });
    await expect(store.claim({ ...claimInput, eventId: "x".repeat(513) })).rejects.toBeInstanceOf(
      FeishuInboundReceiptError,
    );
    await expect(store.claim({ ...claimInput, eventId: "event\n1" })).rejects.toMatchObject({
      code: "FEISHU_RECEIPT_EVENT_ID_INVALID",
    });
    await expect(store.claim({ ...claimInput, credentialGeneration: 0 })).rejects.toMatchObject({
      code: "FEISHU_RECEIPT_GENERATION_INVALID",
    });
    expect(fake.database.insert).not.toHaveBeenCalled();
  });

  it("atomically claims one binding-scoped event and returns a stable duplicate result", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const metrics: unknown[] = [];
    const fake = createReceiptDatabase();
    const store = new FeishuInboundReceiptStore(fake.database, {
      now: () => now,
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(store.claim(claimInput)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      receiptId: "receipt-1",
      status: "processing",
    });
    await expect(store.claim(claimInput)).resolves.toEqual({
      accepted: false,
      duplicate: true,
      receiptId: "receipt-1",
      status: "processing",
    });
    await expect(store.claim({ ...claimInput, bindingId: "binding-2" })).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect(fake.rows).toHaveLength(2);
    expect(metrics).toEqual([
      { type: "receipt", bindingId: "binding-1", eventId: "event-1", status: "processing" },
      { type: "duplicate", bindingId: "binding-1", eventId: "event-1", status: "processing" },
      { type: "receipt", bindingId: "binding-2", eventId: "event-1", status: "processing" },
    ]);
  });

  it("records processed and sanitized failed outcomes", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const metrics: unknown[] = [];
    const fake = createReceiptDatabase();
    const store = new FeishuInboundReceiptStore(fake.database, {
      now: () => now,
      onMetric: (metric) => metrics.push(metric),
    });

    const claim = await store.claim(claimInput);
    await store.markProcessed(claim.receiptId as string);
    expect(fake.rows[0]).toMatchObject({
      status: "processed",
      processedAt: now,
      lastErrorCode: null,
      lastErrorAt: null,
    });

    await store.markFailed(claim.receiptId as string, "provider failure / token\nvalue");
    expect(fake.rows[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "provider_failure___token_value",
      lastErrorAt: now,
    });
    expect(metrics).toEqual([
      { type: "receipt", bindingId: "binding-1", eventId: "event-1", status: "processing" },
      { type: "receipt", bindingId: "binding-1", eventId: "event-1", status: "processed" },
      {
        type: "receipt",
        bindingId: "binding-1",
        eventId: "event-1",
        status: "failed",
        errorCode: "provider_failure___token_value",
      },
    ]);
  });
});
