import { chmod, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginOutgoingReplyInflight,
  collectOutgoingReplyReceipts,
  markOutgoingReplyCaptureStatus,
  PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES,
  writeOutgoingReplyReceipt,
} from "../runtime/provider-cli/outgoing-reply-store.js";
import { sweepAbandonedOutgoingReplyRuns } from "../runtime/provider-cli/outgoing-reply-sweep.js";
import {
  providerCliOutgoingReplyReceiptsDir,
  providerCliOutgoingReplyRunDir,
} from "../runtime/provider-cli/turn-plan.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function harness() {
  const plansRoot = await realpath(await mkdtemp(join(tmpdir(), "outgoing-store-bounds-")));
  roots.push(plansRoot);
  const location = { plansRoot, sessionDir: join(plansRoot, "session"), runId: "run-1" };
  const save = (messageId: string, post?: unknown) =>
    writeOutgoingReplyReceipt({
      ...location,
      receipt: {
        recordedAt: "2026-09-08T08:00:00.000Z",
        sequenceHint: 1,
        kind: "send",
        messageId,
        chatId: "oc_chat",
        contentStatus: "available",
        content: post === undefined ? { msgType: "text", text: "Actual body" } : { msgType: "post", post },
      },
    });
  return { ...location, save, receiptsDir: providerCliOutgoingReplyReceiptsDir(location.sessionDir, location.runId) };
}

describe("bounded outgoing reply storage", () => {
  it("retains known receipts when another capture failed", async () => {
    const h = await harness();
    await h.save("om_valid");
    await markOutgoingReplyCaptureStatus({ ...h, status: "unavailable" });
    const collected = await collectOutgoingReplyReceipts(h);
    expect(collected.status).toBe("incomplete");
    expect(collected.receipts.map((receipt) => receipt.messageId)).toEqual(["om_valid"]);
  });

  it("rejects public or oversized records without losing private valid receipts", async () => {
    const h = await harness();
    await h.save("om_public");
    const [publicName] = await readdir(h.receiptsDir);
    if (!publicName) throw new Error("Expected receipt file");
    await chmod(join(h.receiptsDir, publicName), 0o644);
    await h.save("om_private");
    await writeFile(join(h.receiptsDir, "oversized.json"), "x".repeat(256 * 1024 + 1), { mode: 0o600 });
    const collected = await collectOutgoingReplyReceipts(h);
    expect(collected.status).toBe("incomplete");
    expect(collected.receipts.map((receipt) => receipt.messageId)).toEqual(["om_private"]);
  });

  it("caps directory enumeration and the aggregate receipt bytes", async () => {
    const count = await harness();
    for (let i = 0; i < PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES + 5; i += 1) await count.save(`om_${i}`);
    const counted = await collectOutgoingReplyReceipts(count);
    expect(counted.status).toBe("incomplete");
    expect(counted.receipts).toHaveLength(PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
    const bytes = await harness();
    for (let i = 0; i < 4; i += 1) await bytes.save(`om_${i}`, { content: "x".repeat(150_000) });
    const bounded = await collectOutgoingReplyReceipts(bytes);
    expect(bounded.status).toBe("incomplete");
    expect(bounded.receipts).toHaveLength(3);
  });

  it("does not alias long provider IDs sharing a filename prefix", async () => {
    const h = await harness();
    const prefix = `om_${"x".repeat(100)}`;
    await h.save(`${prefix}a`);
    await h.save(`${prefix}b`);
    expect((await collectOutgoingReplyReceipts(h)).receipts).toHaveLength(2);
  });

  it("orders equal provider timestamps by sequence then message id", async () => {
    const h = await harness();
    const shared = {
      recordedAt: "2026-09-08T08:00:00.000Z",
      kind: "send" as const,
      chatId: "oc_chat",
      createTime: "2026-09-08 16:33:38",
      contentStatus: "unavailable" as const,
      content: { msgType: "unknown" as const, unavailable: "content_read_failed" as const },
    };
    await writeOutgoingReplyReceipt({
      ...h,
      receipt: { ...shared, sequenceHint: 2, messageId: "om_a" },
    });
    await writeOutgoingReplyReceipt({
      ...h,
      receipt: { ...shared, sequenceHint: 1, messageId: "om_z" },
    });
    expect((await collectOutgoingReplyReceipts(h)).receipts.map((receipt) => receipt.messageId)).toEqual([
      "om_z",
      "om_a",
    ]);
  });

  it("re-reads capture status after inflight drain", async () => {
    const h = await harness();
    const inflight = await beginOutgoingReplyInflight(h);
    const collected = await collectOutgoingReplyReceipts({
      ...h,
      waitMs: 400,
      sleep: async () => {
        await markOutgoingReplyCaptureStatus({ ...h, status: "incomplete" });
        await inflight.release();
      },
    });
    expect(collected.status).toBe("incomplete");
    expect(collected.receipts).toEqual([]);
  });

  it.each(["symlinked-status", "public-status", "unknown-entry"])("preserves old receipts with %s", async (unsafe) => {
    const h = await harness();
    await h.save("om_preserved");
    const runDir = providerCliOutgoingReplyRunDir(h.sessionDir, h.runId);
    const statusPath = join(runDir, "capture-status.json");
    if (unsafe === "symlinked-status") {
      const outside = join(h.plansRoot, "outside.json");
      await writeFile(outside, "outside", { mode: 0o600 });
      await symlink(outside, statusPath);
    } else if (unsafe === "public-status") {
      await writeFile(statusPath, "unknown", { mode: 0o644 });
    } else {
      await writeFile(join(runDir, "unknown-evidence"), "keep", { mode: 0o600 });
    }
    await sweepAbandonedOutgoingReplyRuns({ ...h, now: () => Date.now() + 8 * 24 * 60 * 60 * 1000 });
    expect(await readdir(h.receiptsDir)).toHaveLength(1);
  });

  it("sweeps inspectable abandoned runs older than seven days and preserves the rest", async () => {
    const oldRun = await harness();
    await oldRun.save("om_old");
    const recent = await harness();
    await recent.save("om_recent");
    const inflightRun = await harness();
    const inflight = await beginOutgoingReplyInflight(inflightRun);
    await inflightRun.save("om_inflight");
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    const active = await harness();
    await active.save("om_active");
    await sweepAbandonedOutgoingReplyRuns({ ...active, activeRunId: "run-1", now: () => later });
    expect(
      (await collectOutgoingReplyReceipts({ ...active, waitMs: 0 })).receipts.map((receipt) => receipt.messageId),
    ).toEqual(["om_active"]);
    await sweepAbandonedOutgoingReplyRuns({ ...oldRun, now: () => later });
    await sweepAbandonedOutgoingReplyRuns({ ...recent, now: Date.now });
    await sweepAbandonedOutgoingReplyRuns({ ...inflightRun, now: () => later });
    expect((await collectOutgoingReplyReceipts({ ...oldRun, waitMs: 0 })).receipts).toEqual([]);
    expect(
      (await collectOutgoingReplyReceipts({ ...recent, waitMs: 0 })).receipts.map((receipt) => receipt.messageId),
    ).toEqual(["om_recent"]);
    expect(
      (await collectOutgoingReplyReceipts({ ...inflightRun, waitMs: 0 })).receipts.map((receipt) => receipt.messageId),
    ).toEqual(["om_inflight"]);
    await inflight.release();
  });
});
