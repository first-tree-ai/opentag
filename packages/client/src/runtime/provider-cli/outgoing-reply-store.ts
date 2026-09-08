import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  type TurnOutgoingReplyContent,
  TurnOutgoingReplyContentSchema,
  type TurnOutgoingReplyMsgType,
  TurnOutgoingReplyMsgTypeSchema,
} from "@opentag/shared";
import { z } from "zod";
import { createLogger } from "../../observability/logger.js";
import {
  assertWithin,
  ensurePrivateDirectory,
  RuntimeStorageError,
  validatePrivateDirectory,
  writeDurableFile,
  writeDurableJson,
} from "../../storage/durable-file.js";
import {
  assertPlanWithinRoot,
  isProviderCliRunKey,
  ProviderCliTurnPlanError,
  providerCliOutgoingReplyInflightDir,
  providerCliOutgoingReplyReceiptsDir,
  providerCliOutgoingReplyRunDir,
  providerCliTurnPlanPath,
} from "./turn-plan.js";

const logger = createLogger("runtime-provider-cli-outgoing-reply");

export const PROVIDER_CLI_OUTGOING_REPLY_RECEIPT_SCHEMA_VERSION = 1;
export const PROVIDER_CLI_OUTGOING_REPLY_FILE_MAX_BYTES = 256 * 1024;
export const PROVIDER_CLI_OUTGOING_REPLY_COLLECT_WAIT_MS = 2_000;
export const PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES = 128;
export const PROVIDER_CLI_OUTGOING_REPLY_COLLECT_MAX_BYTES = 512 * 1024;

const CaptureStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["complete", "incomplete", "unavailable"]),
  })
  .strict();

const OutgoingReplyReceiptSchema = z
  .object({
    schemaVersion: z.literal(PROVIDER_CLI_OUTGOING_REPLY_RECEIPT_SCHEMA_VERSION),
    recordedAt: z.string().datetime(),
    sequenceHint: z.number().int().safe().nonnegative(),
    kind: z.enum(["send", "reply"]),
    messageId: z.string().min(1).max(512),
    chatId: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512).optional(),
    rootId: z.string().min(1).max(512).optional(),
    parentId: z.string().min(1).max(512).optional(),
    createTime: z.string().min(1).max(64).optional(),
    senderType: z.string().min(1).max(64).optional(),
    senderId: z.string().min(1).max(512).optional(),
    msgType: TurnOutgoingReplyMsgTypeSchema.optional(),
    contentStatus: z.enum(["available", "unavailable", "truncated"]),
    content: TurnOutgoingReplyContentSchema.optional(),
  })
  .strict();

export type ProviderCliOutgoingReplyReceipt = z.infer<typeof OutgoingReplyReceiptSchema>;
export type ProviderCliOutgoingReplyCaptureStatus = z.infer<typeof CaptureStatusSchema>["status"];

export interface ProviderCliOutgoingReplyCollectResult {
  readonly status: "complete" | "incomplete" | "unavailable";
  readonly receipts: readonly ProviderCliOutgoingReplyReceipt[];
}

export async function beginOutgoingReplyInflight(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly runId: string;
}): Promise<{ release(): Promise<void> }> {
  const inflightDir = providerCliOutgoingReplyInflightDir(options.sessionDir, options.runId);
  await ensurePrivateDirectory(options.plansRoot, inflightDir);
  await assertPrivateAncestry(options.plansRoot, inflightDir);
  const path = join(inflightDir, `${process.pid}-${randomUUID()}`);
  await writeDurableJson(path, { pid: process.pid });
  return {
    async release() {
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}

export async function markOutgoingReplyCaptureStatus(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly runId: string;
  readonly status: ProviderCliOutgoingReplyCaptureStatus;
}): Promise<void> {
  const runDir = providerCliOutgoingReplyRunDir(options.sessionDir, options.runId);
  try {
    await ensurePrivateDirectory(options.plansRoot, runDir);
    const path = captureStatusPath(options.sessionDir, options.runId);
    const existing = await readCaptureStatusFile(path);
    const next = worseCaptureStatus(existing, options.status);
    await writeDurableFile(path, `${JSON.stringify({ schemaVersion: 1, status: next })}\n`);
  } catch {
    logger.debug({ code: "outgoing_reply_status_write_failed" }, "Outgoing reply capture status write failed");
  }
}

export async function writeOutgoingReplyReceipt(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly runId: string;
  readonly receipt: Omit<ProviderCliOutgoingReplyReceipt, "schemaVersion">;
}): Promise<void> {
  const receiptsDir = providerCliOutgoingReplyReceiptsDir(options.sessionDir, options.runId);
  await ensurePrivateDirectory(options.plansRoot, receiptsDir);
  await assertPrivateAncestry(options.plansRoot, receiptsDir);
  const receipt: ProviderCliOutgoingReplyReceipt = OutgoingReplyReceiptSchema.parse({
    schemaVersion: PROVIDER_CLI_OUTGOING_REPLY_RECEIPT_SCHEMA_VERSION,
    ...options.receipt,
  });
  const path = join(receiptsDir, receiptFileName(receipt.sequenceHint, receipt.messageId));
  const serialized = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(serialized, "utf8") <= PROVIDER_CLI_OUTGOING_REPLY_FILE_MAX_BYTES) {
    await writeDurableFile(path, serialized);
    return;
  }
  const reduced = OutgoingReplyReceiptSchema.parse({
    ...receipt,
    contentStatus: "truncated",
    content: boundReceiptContent(receipt.content, true),
  });
  await writeDurableFile(path, `${JSON.stringify(reduced)}\n`);
}

export async function collectOutgoingReplyReceipts(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly runId: string;
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<ProviderCliOutgoingReplyCollectResult> {
  const sessionStatus = await outgoingReplySessionStatus(options.plansRoot, options.sessionDir, options.runId);
  if (sessionStatus !== "ready") return { status: sessionStatus, receipts: [] };
  const marked = await readCaptureStatusFile(captureStatusPath(options.sessionDir, options.runId));
  const inflight = await waitForOutgoingReplyInflight(options);
  const collected = await readOutgoingReplyReceipts(
    options.plansRoot,
    providerCliOutgoingReplyReceiptsDir(options.sessionDir, options.runId),
  );
  const unavailable = marked === "unavailable" || inflight === "unavailable" || collected.status === "unavailable";
  const incomplete = inflight === "timeout" || marked === "incomplete" || collected.incomplete;
  if (unavailable && collected.receipts.length === 0) {
    return { status: "unavailable", receipts: [] };
  }
  return {
    status: unavailable || incomplete ? "incomplete" : "complete",
    receipts: collected.receipts,
  };
}

export async function cleanupOutgoingReplyRun(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly runId: string;
}): Promise<void> {
  const runDir = providerCliOutgoingReplyRunDir(options.sessionDir, options.runId);
  try {
    await assertPrivateAncestry(options.plansRoot, runDir);
    if (!(await validatePrivateDirectory(options.plansRoot, runDir))) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof ProviderCliTurnPlanError || error instanceof RuntimeStorageError) return;
    logger.debug({ code: "outgoing_reply_cleanup_validation_failed" }, "Outgoing reply cleanup validation failed");
    throw error;
  }
  await rm(runDir, { recursive: true, force: true });
}

export async function recoverSessionOutgoingReplyEvidence(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
}): Promise<boolean> {
  try {
    await assertPrivateAncestry(options.plansRoot, options.sessionDir);
    if (!(await validatePrivateDirectory(options.plansRoot, options.sessionDir))) return false;
    if (!(await sessionHasOutgoingReplyEvidence(options.plansRoot, options.sessionDir))) return false;
    await rm(providerCliTurnPlanPath(options.sessionDir), { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ProviderCliTurnPlanError("unsafe", "Outgoing reply evidence could not be safely recovered");
  }
}

async function sessionHasOutgoingReplyEvidence(plansRoot: string, sessionDir: string): Promise<boolean> {
  const runsDir = join(sessionDir, "runs");
  const listed = await listPrivateFiles(plansRoot, runsDir, PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
  if (listed === "missing") return false;
  if (listed === "unavailable" || listed.length >= PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES) return true;
  for (const name of listed) {
    if (!isProviderCliRunKey(name)) continue;
    const runDir = join(runsDir, name);
    if (await runHasOutgoingReplyEvidence(plansRoot, runDir)) return true;
  }
  return false;
}

async function runHasOutgoingReplyEvidence(plansRoot: string, runDir: string): Promise<boolean> {
  const runFiles = await listPrivateFiles(plansRoot, runDir, PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
  if (runFiles === "missing") return false;
  if (runFiles === "unavailable") return true;
  const status = await readCaptureStatusFile(join(runDir, "capture-status.json"));
  if (status) return true;
  const listed = await listPrivateFiles(
    plansRoot,
    join(runDir, "outgoing-replies"),
    PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES,
  );
  if (listed === "missing" || listed === "unavailable") return false;
  return listed.some((name) => name.endsWith(".json"));
}

async function outgoingReplySessionStatus(
  plansRoot: string,
  sessionDir: string,
  _runId: string,
): Promise<"ready" | "complete" | "unavailable"> {
  try {
    await assertPrivateAncestry(plansRoot, sessionDir);
    if (!(await validatePrivateDirectory(plansRoot, sessionDir))) return "complete";
    return "ready";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "complete";
    logger.debug({ code: "outgoing_reply_session_dir_invalid" }, "Outgoing reply session directory validation failed");
    return "unavailable";
  }
}

async function waitForOutgoingReplyInflight(options: {
  readonly plansRoot: string;
  readonly sessionDir: string;
  readonly runId: string;
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<"clear" | "timeout" | "unavailable"> {
  const inflightDir = providerCliOutgoingReplyInflightDir(options.sessionDir, options.runId);
  const waitMs = options.waitMs ?? PROVIDER_CLI_OUTGOING_REPLY_COLLECT_WAIT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + Math.max(0, waitMs);
  while (true) {
    const inflight = await listPrivateFiles(
      options.plansRoot,
      inflightDir,
      PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES,
    );
    if (inflight === "unavailable") return "unavailable";
    if (inflight === "missing" || inflight.length === 0) return "clear";
    if (now() >= deadline) return "timeout";
    await sleep(20);
  }
}

async function readOutgoingReplyReceipts(
  plansRoot: string,
  receiptsDir: string,
): Promise<{ status: "ok" | "unavailable"; incomplete: boolean; receipts: ProviderCliOutgoingReplyReceipt[] }> {
  const files = await listPrivateFiles(plansRoot, receiptsDir, PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES);
  if (files === "missing") return { status: "ok", incomplete: false, receipts: [] };
  if (files === "unavailable") return { status: "unavailable", incomplete: true, receipts: [] };
  const receipts: ProviderCliOutgoingReplyReceipt[] = [];
  let incomplete = files.length >= PROVIDER_CLI_OUTGOING_REPLY_MAX_DIRECTORY_ENTRIES;
  let totalBytes = 0;
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    if (totalBytes >= PROVIDER_CLI_OUTGOING_REPLY_COLLECT_MAX_BYTES) {
      incomplete = true;
      break;
    }
    const limit = Math.min(
      PROVIDER_CLI_OUTGOING_REPLY_FILE_MAX_BYTES,
      PROVIDER_CLI_OUTGOING_REPLY_COLLECT_MAX_BYTES - totalBytes,
    );
    const bounded = await readBoundedJsonFile(join(receiptsDir, name), limit, (value) =>
      OutgoingReplyReceiptSchema.parse(value),
    );
    if (bounded === "missing") continue;
    if (bounded === "too-large" || bounded === "invalid") {
      // Failed parsing can still consume the full read allowance.
      totalBytes += limit;
      incomplete = true;
      continue;
    }
    totalBytes += bounded.bytes;
    if (totalBytes > PROVIDER_CLI_OUTGOING_REPLY_COLLECT_MAX_BYTES) {
      incomplete = true;
      break;
    }
    receipts.push(bounded.value);
  }
  receipts.sort(compareOutgoingReplyReceipts);
  return { status: "ok", incomplete, receipts };
}

function compareOutgoingReplyReceipts(
  left: ProviderCliOutgoingReplyReceipt,
  right: ProviderCliOutgoingReplyReceipt,
): number {
  const leftKey = receiptOrderKey(left);
  const rightKey = receiptOrderKey(right);
  if (leftKey !== rightKey) return leftKey - rightKey;
  return left.messageId.localeCompare(right.messageId);
}

function receiptOrderKey(receipt: ProviderCliOutgoingReplyReceipt): number {
  const created = parseProviderCreateTime(receipt.createTime);
  if (created !== undefined) return created;
  return receipt.sequenceHint;
}

function parseProviderCreateTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function listPrivateFiles(
  plansRoot: string,
  directory: string,
  maxEntries: number,
): Promise<readonly string[] | "missing" | "unavailable"> {
  try {
    await assertPrivateAncestry(plansRoot, directory);
    if (!(await validatePrivateDirectory(plansRoot, directory))) return "missing";
    const entries: string[] = [];
    const handle = await opendir(directory, { bufferSize: Math.min(32, maxEntries) });
    for await (const entry of handle) {
      entries.push(entry.name);
      if (entries.length >= maxEntries) break;
    }
    return entries.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    logger.debug({ code: "outgoing_reply_dir_list_failed" }, "Outgoing reply directory listing failed");
    return "unavailable";
  }
}

async function readBoundedJsonFile<T>(
  path: string,
  maxBytes: number,
  validate: (value: unknown) => T,
): Promise<{ value: T; bytes: number } | "missing" | "too-large" | "invalid"> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) return "invalid";
    if (status.size > maxBytes) return "too-large";
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) return "too-large";
    if ((opened.mode & 0o077) !== 0 || (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
      return "invalid";
    }
    const buffer = await readCappedBuffer(handle, maxBytes);
    if (buffer.length > maxBytes) return "too-large";
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return { value: validate(parsed), bytes: buffer.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "invalid";
  } finally {
    await handle?.close();
  }
}

async function readCappedBuffer(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytes = 0;
  while (bytes <= maxBytes) {
    const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
    if (read.bytesRead === 0) break;
    bytes += read.bytesRead;
  }
  return buffer.subarray(0, bytes);
}

async function readCaptureStatusFile(path: string): Promise<ProviderCliOutgoingReplyCaptureStatus | undefined> {
  const parsed = await readBoundedJsonFile(path, 1024, (value) => CaptureStatusSchema.parse(value));
  if (parsed === "missing") return undefined;
  if (parsed === "too-large" || parsed === "invalid") return "unavailable";
  return parsed.value.status;
}

function captureStatusPath(sessionDir: string, runId: string): string {
  return join(providerCliOutgoingReplyRunDir(sessionDir, runId), "capture-status.json");
}

function worseCaptureStatus(
  existing: ProviderCliOutgoingReplyCaptureStatus | undefined,
  next: ProviderCliOutgoingReplyCaptureStatus,
): ProviderCliOutgoingReplyCaptureStatus {
  const rank = { complete: 0, incomplete: 1, unavailable: 2 } as const;
  if (!existing) return next;
  return rank[next] >= rank[existing] ? next : existing;
}

async function assertPrivateAncestry(root: string, target: string): Promise<void> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  assertPlanWithinRoot(rootPath, targetPath);
  assertWithin(rootPath, targetPath);
  const suffix = relative(rootPath, targetPath);
  let current = rootPath;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const segment of suffix ? ["", ...suffix.split(sep)] : [""]) {
    if (segment) current = resolve(current, segment);
    const status = await lstat(current);
    if (status.isSymbolicLink()) {
      throw new ProviderCliTurnPlanError("unsafe", "Outgoing reply path must not traverse a symlink");
    }
    if (uid !== undefined && status.uid !== uid) {
      throw new ProviderCliTurnPlanError("unsafe", "Outgoing reply path must be owned by the daemon account");
    }
    if (status.isDirectory() && (status.mode & 0o077) !== 0) {
      throw new ProviderCliTurnPlanError("unsafe", "Outgoing reply directories must be private");
    }
  }
}

function receiptFileName(sequenceHint: number, messageId: string): string {
  const safeId = createHash("sha256").update(messageId).digest("hex");
  return `${String(sequenceHint).padStart(16, "0")}-${safeId}.json`;
}

function boundReceiptContent(
  content: TurnOutgoingReplyContent | undefined,
  truncated: boolean,
): TurnOutgoingReplyContent {
  const msgType: TurnOutgoingReplyMsgType = content?.msgType ?? "unknown";
  return {
    msgType,
    ...(content?.filename ? { filename: content.filename } : {}),
    ...(content?.fileKey ? { fileKey: content.fileKey } : {}),
    ...(content?.imageKey ? { imageKey: content.imageKey } : {}),
    unavailable: truncated ? "content_truncated" : (content?.unavailable ?? "content_read_failed"),
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
