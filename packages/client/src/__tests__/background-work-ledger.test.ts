import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent } from "../agent-runtime/types.js";
import {
  BackgroundWorkLedger,
  type BackgroundWorkLedgerState,
  BackgroundWorkLedgers,
  parseBackgroundWorkLedgerState,
} from "../runtime/background-work-ledger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function memory(initial?: unknown) {
  const box: { state: unknown } = { state: initial };
  return {
    box,
    read: async () => box.state,
    write: async (state: BackgroundWorkLedgerState) => {
      box.state = JSON.parse(JSON.stringify(state));
    },
    remove: async () => {
      box.state = undefined;
    },
  };
}

const changed = (...items: { id: string; label: string; outputPath?: string }[]): AgentRuntimeEvent => ({
  type: "background_work_changed",
  runId: "run",
  items,
});
const finished = (
  id: string,
  status: "completed" | "failed" | "stopped",
  extra: { detail?: string; outputPath?: string } = {},
): AgentRuntimeEvent => ({ type: "background_work_finished", runId: "run", id, status, ...extra });
const turn: AgentRuntimeEvent = { type: "model_turn_started", runId: "run", modelTurnId: "t" };

describe("BackgroundWorkLedger", () => {
  it("has nothing to say about a Session with no history", async () => {
    const ledger = new BackgroundWorkLedger(memory());
    await expect(ledger.notice()).resolves.toBeUndefined();
    const input = { items: [{ type: "text" as const, text: "hello" }] };
    await expect(ledger.prefix(input)).resolves.toBe(input);
  });

  it("reports results it saw as facts and work it lost track of as unconfirmed", async () => {
    const storage = memory();
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(
      changed(
        { id: "a", label: "suite" },
        { id: "b", label: "build", outputPath: "/b.log" },
        { id: "c", label: "deploy" },
        { id: "d", label: "lint" },
      ),
    );
    await ledger.apply(finished("a", "completed", { detail: "exit 0", outputPath: "/a.log" }));
    await ledger.apply(finished("c", "failed"));
    await ledger.apply(finished("d", "stopped"));
    await ledger.apply(finished("unlisted", "completed"));
    const notice = await ledger.notice();
    expect(notice?.split("\n")).toEqual([
      "[openTag notice] A previous Run left background work behind.",
      "Background work from that Run:",
      "- suite (completed; exit 0; output: /a.log)",
      "- build (status unknown: its process ended, so it may have stopped or may still be running; check with ps or its output; output: /b.log)",
      "- deploy (failed)",
      "- lint (stopped, no result)",
      "Do not rely on this work without checking it, and start it again if you still need it.",
    ]);
    // Unrelated events leave it alone, and work a later Run reads no longer counts as live.
    await ledger.apply({ type: "run_started", runId: "run" });
    expect(storage.box.state).toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ id: "b", status: "unknown" })]),
    });
    await expect(ledger.notice()).resolves.toBe(notice);
  });

  it("keeps the notice until a model turn starts, so a crash before that tells the next Run again", async () => {
    const storage = memory();
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(changed({ id: "a", label: "suite" }));
    await ledger.recordRunLimit({ reason: "turn_timeout", at: "2026-11-07T10:00:00.000Z" });
    const first = await ledger.prefix({ items: [{ type: "text", text: "next" }] });
    expect(first.items[0]?.text).toContain("Your previous Run reached its duration limit at 2026-11-07T10:00:00.000Z");
    expect(first.items[0]?.text).toContain("- suite (status unknown");
    expect(first.items[1]?.text).toBe("next");
    await expect(ledger.notice()).resolves.toContain("duration limit");
    await ledger.apply(turn);
    await expect(ledger.notice()).resolves.toBeUndefined();
    expect(storage.box.state).toBeUndefined();
  });

  it("tells a Session its Run hit a limit even with no background work, and names a new kind of limit", async () => {
    const ledger = new BackgroundWorkLedger(memory());
    await ledger.recordRunLimit({ reason: "tool_call_limit", at: "T" });
    await expect(ledger.notice()).resolves.toBe(
      "[openTag notice] Your previous Run reached its limit (tool_call_limit) at T and was stopped. Whoever was waiting for it has been told.",
    );
  });

  it("tells the next Run when a later turn failed after the input was answered, and keeps what that turn missed", async () => {
    const ledger = new BackgroundWorkLedger(memory());
    await ledger.apply(changed({ id: "a", label: "suite" }));
    await ledger.apply(finished("a", "completed", { detail: "exit 0" }));
    await ledger.apply({
      type: "run_completed",
      runId: "run",
      result: {
        runId: "run",
        status: "completed",
        output: [],
        followUpFailure: { code: "provider_rate_limited", message: "429" },
      },
    });
    const notice = await ledger.notice();
    expect(notice).toContain("failed (provider_rate_limited)");
    expect(notice).toContain("- suite (completed; exit 0)");
    await ledger.apply(turn);
    await expect(ledger.notice()).resolves.toBeUndefined();
  });

  it("tells the next Run when a used-up model quota resets, if the failed turn said", async () => {
    const ledger = new BackgroundWorkLedger(memory());
    const quota = (retryAt?: string): AgentRuntimeEvent => ({
      type: "run_completed",
      runId: "run",
      result: {
        runId: "run",
        status: "completed",
        output: [],
        followUpFailure: { code: "provider_quota_exceeded", message: "limit", ...(retryAt ? { retryAt } : {}) },
      },
    });
    await ledger.apply(quota("2026-11-11T12:00:00.000Z"));
    await expect(ledger.notice()).resolves.toContain(
      "failed (provider_quota_exceeded), so that work may be unfinished. The model is available again at 2026-11-11T12:00:00.000Z.",
    );
    // A later failure without a reset time does not keep the old one.
    await ledger.apply(quota());
    await expect(ledger.notice()).resolves.not.toContain("available again");
    await ledger.apply(turn);
    await expect(ledger.notice()).resolves.toBeUndefined();
  });

  it("counts a message as a model turn, for a Provider that reports no turns", async () => {
    const ledger = new BackgroundWorkLedger(memory());
    await ledger.apply(changed({ id: "a", label: "suite" }));
    await ledger.apply(finished("a", "completed"));
    await ledger.apply({ type: "message_started", runId: "run", messageId: "m" });
    await expect(ledger.notice()).resolves.toBeUndefined();
  });

  it("does not drop live work when a model turn starts, and drops a finished result once one has", async () => {
    const storage = memory();
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(changed({ id: "a", label: "suite" }, { id: "b", label: "build" }));
    await ledger.apply(finished("a", "completed"));
    await ledger.apply(turn);
    expect((storage.box.state as BackgroundWorkLedgerState).entries).toEqual([
      { id: "b", label: "build", status: "running" },
    ]);
  });

  it("forgets running work that leaves the list without a result, such as a wakeup that fired", async () => {
    const storage = memory();
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(changed({ id: "wake", label: "ScheduleWakeup timer" }));
    await ledger.apply(changed());
    expect(storage.box.state).toBeUndefined();
  });

  it("keeps a result when the list changes after it, and updates what it knows of live work", async () => {
    const storage = memory();
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(changed({ id: "a", label: "suite" }, { id: "b", label: "build" }));
    await ledger.apply(finished("a", "completed", { detail: "x".repeat(5_000) }));
    await ledger.apply(changed({ id: "b", label: "build", outputPath: "/b" }));
    const { entries } = storage.box.state as BackgroundWorkLedgerState;
    expect(entries.map(({ id, status }) => [id, status])).toEqual([
      ["a", "completed"],
      ["b", "running"],
    ]);
    expect(entries[0]?.detail).toHaveLength(2_000);
    expect(entries[1]?.outputPath).toBe("/b");
  });

  it("keeps the newest entries when work piles up", async () => {
    const storage = memory();
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(changed(...Array.from({ length: 40 }, (_, index) => ({ id: `t${index}`, label: `t${index}` }))));
    const { entries } = storage.box.state as BackgroundWorkLedgerState;
    expect(entries).toHaveLength(32);
    expect(entries.at(-1)?.id).toBe("t39");
  });

  it("does not write when nothing changed", async () => {
    const storage = memory();
    const write = vi.spyOn(storage, "write");
    const ledger = new BackgroundWorkLedger(storage);
    await ledger.apply(changed({ id: "a", label: "suite" }));
    await ledger.apply(changed({ id: "a", label: "suite" }));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never lets a storage failure reach the Run", async () => {
    const onError = vi.fn();
    const ledger = new BackgroundWorkLedger(
      {
        read: async () => {
          throw new Error("disk");
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      onError,
    );
    await expect(ledger.apply(changed({ id: "a", label: "suite" }))).resolves.toBeUndefined();
    await expect(ledger.notice()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    const silent = new BackgroundWorkLedger(memory("not a ledger"));
    await expect(silent.notice()).resolves.toBeUndefined();
  });

  it("rejects a record it cannot read", () => {
    expect(() => parseBackgroundWorkLedgerState(undefined)).toThrow("invalid");
    expect(() => parseBackgroundWorkLedgerState({ schemaVersion: 2, entries: [] })).toThrow("invalid");
    expect(() => parseBackgroundWorkLedgerState({ schemaVersion: 1 })).toThrow("invalid");
  });
});

describe("BackgroundWorkLedgers", () => {
  it("keeps one private file per Session on disk, across a restart, and removes it when read", async () => {
    const home = await mkdtemp(join(tmpdir(), "background-work-"));
    directories.push(home);
    const before = new BackgroundWorkLedgers(home);
    await expect(before.forSession("session-1").notice()).resolves.toBeUndefined();
    expect(before.forSession("session-1")).toBe(before.forSession("session-1"));
    await before.forSession("session-1").apply(changed({ id: "a", label: "suite" }));
    await before.forSession("session-2").apply(changed({ id: "b", label: "other" }));

    const after = new BackgroundWorkLedgers(home);
    await expect(after.forSession("session-1").notice()).resolves.toContain("- suite");
    await expect(after.forSession("session-1").notice()).resolves.not.toContain("- other");
    await after.forSession("session-1").apply(turn);
    await expect(after.forSession("session-1").notice()).resolves.toBeUndefined();
    // Removing what is already gone is fine.
    await after.forSession("session-1").recordRunLimit({ reason: "turn_timeout", at: "T" });
    await after.forSession("session-1").apply(turn);
    const runtime = join(home, ...(await findRuntime(home)));
    await expect(readdir(runtime)).resolves.toHaveLength(1);
  });

  it("treats a file already gone as removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "background-work-"));
    directories.push(home);
    const onError = vi.fn();
    const ledger = new BackgroundWorkLedgers(home, onError).forSession("session-1");
    await ledger.apply(changed({ id: "a", label: "suite" }));
    await ledger.apply(finished("a", "completed"));
    const runtime = join(home, ...(await findRuntime(home)));
    const [file] = await readdir(runtime);
    const storagePath = join(runtime, file as string);
    const racing = ledger.apply(turn);
    await rm(storagePath, { force: true });
    await racing;
    await ledger.apply(turn);
    expect(onError).not.toHaveBeenCalled();
  });
});

async function findRuntime(home: string): Promise<string[]> {
  for (const entry of await readdir(home, { recursive: true })) {
    if (String(entry).endsWith("background-work")) return [String(entry)];
  }
  throw new Error("no ledger directory");
}
