import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { SlackWebhookReceiptError, SlackWebhookReceiptStore } from "../services/im-bindings/slack/index.js";

interface ReceiptRow {
  id: string;
  installationId: string;
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
              (row) =>
                row.installationId === values.installationId &&
                row.credentialGeneration === values.credentialGeneration &&
                row.eventId === values.eventId,
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
            return [{ id: row.id, installationId: row.installationId, eventId: row.eventId }];
          }),
        })),
      })),
    })),
  };

  return { database: database as unknown as DatabaseClient, rows };
}

const claimInput = {
  installationId: "installation-1",
  credentialGeneration: 3,
  eventId: "event-1",
};

describe("SlackWebhookReceiptStore", () => {
  it("rejects empty, oversized, and non-printable event ids before touching the database", async () => {
    const fake = createReceiptDatabase();
    const store = new SlackWebhookReceiptStore(fake.database);

    await expect(store.claim({ ...claimInput, eventId: "" })).rejects.toMatchObject({
      code: "SLACK_RECEIPT_EVENT_ID_INVALID",
    });
    await expect(store.claim({ ...claimInput, eventId: "x".repeat(256) })).rejects.toBeInstanceOf(
      SlackWebhookReceiptError,
    );
    await expect(store.claim({ ...claimInput, eventId: "event\n1" })).rejects.toMatchObject({
      code: "SLACK_RECEIPT_EVENT_ID_INVALID",
    });
    expect(fake.database.insert).not.toHaveBeenCalled();
  });

  it("claims a new receipt and returns an existing row for duplicate deliveries", async () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const metrics: unknown[] = [];
    const fake = createReceiptDatabase();
    const store = new SlackWebhookReceiptStore(fake.database, {
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
    expect(fake.rows).toHaveLength(1);
    expect(metrics).toEqual([
      { type: "receipt", installationId: claimInput.installationId, eventId: claimInput.eventId, status: "processing" },
      {
        type: "duplicate",
        installationId: claimInput.installationId,
        eventId: claimInput.eventId,
        status: "processing",
      },
    ]);
  });

  it("marks receipts processed and emits no metric when the row is missing", async () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const metrics: unknown[] = [];
    const fake = createReceiptDatabase([
      {
        id: "receipt-1",
        installationId: claimInput.installationId,
        credentialGeneration: claimInput.credentialGeneration,
        eventId: claimInput.eventId,
        status: "processing",
      },
    ]);
    const store = new SlackWebhookReceiptStore(fake.database, {
      now: () => now,
      onMetric: (metric) => metrics.push(metric),
    });

    await store.markProcessed("receipt-1");
    expect(fake.rows[0]).toMatchObject({
      status: "processed",
      processedAt: now,
      lastErrorCode: null,
      lastErrorAt: null,
    });
    expect(metrics).toEqual([
      { type: "receipt", installationId: claimInput.installationId, eventId: claimInput.eventId, status: "processed" },
    ]);

    const empty = createReceiptDatabase();
    const emptyMetrics: unknown[] = [];
    await new SlackWebhookReceiptStore(empty.database, {
      onMetric: (metric) => emptyMetrics.push(metric),
    }).markProcessed("missing");
    expect(emptyMetrics).toEqual([]);
  });

  it("sanitizes failure codes, records failure time, and handles missing rows", async () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const metrics: unknown[] = [];
    const fake = createReceiptDatabase([
      {
        id: "receipt-1",
        installationId: claimInput.installationId,
        credentialGeneration: claimInput.credentialGeneration,
        eventId: claimInput.eventId,
        status: "processing",
      },
    ]);
    const store = new SlackWebhookReceiptStore(fake.database, {
      now: () => now,
      onMetric: (metric) => metrics.push(metric),
    });

    await store.markFailed("receipt-1", "provider failure / secret\nvalue");
    expect(fake.rows[0]).toMatchObject({
      status: "failed",
      lastErrorCode: "provider_failure___secret_value",
      lastErrorAt: now,
    });
    expect(metrics).toEqual([
      {
        type: "receipt",
        installationId: claimInput.installationId,
        eventId: claimInput.eventId,
        status: "failed",
        errorCode: "provider_failure___secret_value",
      },
    ]);

    const empty = createReceiptDatabase();
    await new SlackWebhookReceiptStore(empty.database).markFailed("missing", "");
    expect(empty.rows).toEqual([]);
  });
});
