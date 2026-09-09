import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../../observability/logger.js";
import {
  assertPrivateAncestry,
  listPrivateFiles,
  PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES,
} from "./outgoing-reply-store.js";
import { deriveProviderCliRunKey, isProviderCliRunKey } from "./turn-plan.js";

const logger = createLogger("runtime-provider-cli-outgoing-reply-sweep");

export const PROVIDER_CLI_OUTGOING_REPLY_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function sweepAbandonedOutgoingReplyRuns(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly activeRunId?: string;
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}): Promise<void> {
  const runsDir = join(options.sessionDir, "runs");
  const listed = await listPrivateFiles(options.plansRoot, runsDir, PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
  if (listed === "missing" || listed === "unavailable") return;
  const activeKey = options.activeRunId ? deriveProviderCliRunKey(options.activeRunId) : undefined;
  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxAgeMs ?? PROVIDER_CLI_OUTGOING_REPLY_ORPHAN_MAX_AGE_MS;
  for (const name of listed) {
    if (!isProviderCliRunKey(name) || name === activeKey) continue;
    const runDir = join(runsDir, name);
    if (!(await shouldSweepAbandonedRun(options.plansRoot, runDir, now, maxAgeMs))) continue;
    await rm(runDir, { recursive: true, force: true }).catch(() => {
      logger.debug({ code: "outgoing_reply_sweep_failed" }, "Abandoned outgoing reply Run could not be removed");
    });
  }
}

async function shouldSweepAbandonedRun(
  plansRoot: string,
  runDir: string,
  now: number,
  maxAgeMs: number,
): Promise<boolean> {
  try {
    await assertPrivateAncestry(plansRoot, runDir);
  } catch {
    return false;
  }
  const inflight = await listPrivateFiles(
    plansRoot,
    join(runDir, "inflight"),
    PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES,
  );
  if (inflight === "unavailable" || (inflight !== "missing" && inflight.length > 0)) return false;
  const mtime = await newestInspectableMtime(plansRoot, runDir);
  return mtime !== undefined && now - mtime >= maxAgeMs;
}

async function newestInspectableMtime(plansRoot: string, runDir: string): Promise<number | undefined> {
  const runEntries = await listPrivateFiles(plansRoot, runDir, PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
  if (typeof runEntries === "string" || runEntries.length >= PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES)
    return undefined;
  if (runEntries.some((name) => !["capture-status.json", "outgoing-replies", "inflight"].includes(name)))
    return undefined;
  const times: number[] = [];
  if ((await addPrivateMtime(times, runDir, "directory")) !== "ok") return undefined;
  if ((await addPrivateMtime(times, join(runDir, "capture-status.json"), "file")) === "unsafe") return undefined;
  if ((await addPrivateMtime(times, join(runDir, "inflight"), "directory")) === "unsafe") return undefined;
  if (!(await addReceiptMtimes(times, plansRoot, runDir))) return undefined;
  return Math.max(...times);
}

async function addReceiptMtimes(times: number[], plansRoot: string, runDir: string): Promise<boolean> {
  const receiptsDir = join(runDir, "outgoing-replies");
  const receipts = await listPrivateFiles(plansRoot, receiptsDir, PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
  if (receipts === "missing") return true;
  if (receipts === "unavailable" || receipts.length >= PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES) return false;
  if ((await addPrivateMtime(times, receiptsDir, "directory")) !== "ok") return false;
  for (const name of receipts) {
    if ((await addPrivateMtime(times, join(receiptsDir, name), "file")) !== "ok") return false;
  }
  return true;
}

async function addPrivateMtime(
  times: number[],
  path: string,
  kind: "file" | "directory",
): Promise<"ok" | "missing" | "unsafe"> {
  try {
    const status = await lstat(path);
    if (kind === "file" ? !status.isFile() : !status.isDirectory()) return "unsafe";
    if ((status.mode & 0o077) !== 0 || (process.getuid && status.uid !== process.getuid())) return "unsafe";
    times.push(status.mtimeMs);
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}
