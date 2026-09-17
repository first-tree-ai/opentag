/**
 * OpenTag web tools Pi extension (trusted built artifact).
 *
 * Loaded explicitly with `pi -e <this file>` for actual execution only; `--no-extensions` stays
 * set so implicit discovery never loads it. The extension registers `web_search`/`web_fetch`,
 * forwards validated calls over the per-execution endpoint named by the nonsecret
 * OPENTAG_WEB_TOOLS_SOCKET descriptor, and saves bounded extracted content under the Session
 * workspace `.opentag/web/<stable-tool-id>/`.
 *
 * This module is intentionally self-contained (Node builtins only, no package imports): it runs
 * inside the Pi process and must never resolve workspace dependencies. The wire authority is
 * `@opentag/shared` web-tools; the gateway and Server re-validate everything authoritatively.
 *
 * Wire/artifact identity: the wire toolCallId is derived deterministically (UUID shape) from the
 * per-execution endpoint descriptor plus the actual Pi runtime tool call ID. Same-execution
 * retries reuse it (stable idempotency); a distinct execution can never collide with or
 * overwrite another execution's artifacts. Failures throw bounded redacted errors so Pi records
 * toolResult.isError=true; a normal return is never used for failed operations.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { join, sep } from "node:path";

/** Named export so Client tests can pin these against the shared wire authority. */
export const WEB_EXTENSION_LIMITS = {
  requestMaxBytes: 16 * 1024,
  searchResponseMaxBytes: 1024 * 1024,
  fetchResponseMaxBytes: 3 * 1024 * 1024,
  previewPageMaxBytes: 12 * 1024,
  toolResultMaxBytes: 48 * 1024,
  pageBodyMaxBytes: 1024 * 1024,
  queryMaxCodepoints: 400,
  searchLimitMax: 10,
  domainsMax: 10,
  fetchUrlsMax: 3,
  urlMaxBytes: 4 * 1024,
  /** End-to-end operation budgets, equal to the shared hard caps; the chain only decreases them. */
  searchTimeoutMs: 15_000,
  fetchTimeoutMs: 45_000,
  protocolVersion: 1,
  /** Remaining-budget hop header (hop metadata, never part of the semantic digest). */
  remainingHeader: "x-web-remaining-ms",
} as const;

const TRUNCATION_MARKER = "…[truncated]";
const ENDPOINT_ENV = "OPENTAG_WEB_TOOLS_SOCKET";
/** UUID-shaped stable id derivation namespace; version/variant bits are set below. */
const TOOL_ID_NAMESPACE = "opentag.web.tool.v1";
/** Exact UUID-v5 shape produced by `deriveWebToolIdentity`; the only id ever used as a directory. */
const TOOL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The deadline controller aborts with this exact reason so callers keep distinct timeout wording. */
const WEB_CALL_TIMED_OUT = "The web call timed out";

/** Plain JSON Schema (no TypeBox dependency); the gateway re-validates with the shared Zod authority. */
export const WEB_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: WEB_EXTENSION_LIMITS.queryMaxCodepoints,
      description: "Search query (1–400 characters), kept verbatim including case.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: WEB_EXTENSION_LIMITS.searchLimitMax,
      default: 5,
      description: "Maximum number of sources to return (default 5).",
    },
    domains: {
      type: "array",
      items: { type: "string" },
      maxItems: WEB_EXTENSION_LIMITS.domainsMax,
      description: "Optional public domain names to scope the search (max 10).",
    },
    timeRange: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Optional recency window for results.",
    },
    language: {
      type: "string",
      description: "Optional language preference (e.g. en, zh-CN, portuguese); not a strict filter.",
    },
    depth: {
      type: "string",
      enum: ["basic", "advanced"],
      default: "basic",
      description: "Search depth; advanced costs more and must be chosen explicitly.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const WEB_FETCH_PARAMETERS = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: WEB_EXTENSION_LIMITS.fetchUrlsMax,
      description: "1–3 public http(s) URLs to extract page content from.",
    },
    depth: {
      type: "string",
      enum: ["basic", "advanced"],
      default: "basic",
      description: "Extraction depth; advanced handles complex pages and must be chosen explicitly.",
    },
  },
  required: ["urls"],
  additionalProperties: false,
} as const;

/* --------------------------- stable tool identity --------------------------- */

/**
 * Deterministic UUID-shaped tool identity: SHA-256 over the derivation namespace, the
 * per-execution endpoint descriptor, and the actual Pi runtime tool call ID, formatted with
 * version-5/variant bits. Same endpoint + same call ID ⇒ same id (stable retry); a different
 * execution endpoint ⇒ a different id (no cross-execution artifact collision).
 */
export function deriveWebToolIdentity(endpointDescriptor: string, runtimeToolCallId: string): string {
  if (typeof runtimeToolCallId !== "string" || runtimeToolCallId.length === 0) {
    throw new Error("The runtime tool call id is missing");
  }
  const hash = createHash("sha256")
    .update(TOOL_ID_NAMESPACE, "utf8")
    .update("", "utf8")
    .update(endpointDescriptor, "utf8")
    .update("", "utf8")
    .update(runtimeToolCallId, "utf8")
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------ byte-safe text ------------------------------ */

/** Truncate to a UTF-8 byte budget on codepoint boundaries, appending a marker when it fits. */
export function truncateToByteBudget(text: string, budgetBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budgetBytes) return { text, truncated: false };
  if (budgetBytes <= 0) return { text: "", truncated: true };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const buffer = Buffer.from(text, "utf8");
  if (budgetBytes < markerBytes) {
    // The marker itself does not fit: cut content only, still codepoint-safe and bounded.
    let cut = budgetBytes;
    while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
    return { text: buffer.subarray(0, cut).toString("utf8"), truncated: true };
  }
  let cut = budgetBytes - markerBytes;
  while (cut > 0 && ((buffer[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return { text: `${buffer.subarray(0, cut).toString("utf8")}${TRUNCATION_MARKER}`, truncated: true };
}

/* ------------------------------ socket client ------------------------------ */

interface GatewayReply {
  status: number;
  body: Buffer;
}

/**
 * Distinguish the operation deadline from a caller abort while keeping the established wording:
 * `The web call was aborted` (never leaks a caller-provided reason), `The web call timed out` when
 * the end-to-end deadline fired. Everything downstream fails closed on either.
 */
function webCallAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message === WEB_CALL_TIMED_OUT) return new Error(WEB_CALL_TIMED_OUT);
  return new Error("The web call was aborted");
}

/**
 * End-to-end operation deadline (original 15s/45s budget): mirrors the caller abort signal and
 * additionally aborts when the remaining budget expires. The returned signal stays live through
 * the HTTP hop AND every artifact write/publication, so filesystem work can never outlive the
 * budget; callers must keep checking it after each await and dispose it in a `finally`.
 */
function startOperationDeadline(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; deadlineAtMs: number; dispose(): void } {
  const deadlineAtMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(WEB_CALL_TIMED_OUT)), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    deadlineAtMs,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function postToGateway(
  socketPath: string,
  path: string,
  payload: unknown,
  options: { deadlineAtMs: number; signal?: AbortSignal; maxResponseBytes: number },
): Promise<GatewayReply> {
  return new Promise((resolvePromise, rejectPromise) => {
    const fail = (message: string) => {
      finish(new Error(message));
    };
    const remainingAtDispatch = options.deadlineAtMs - Date.now();
    if (options.signal?.aborted) {
      rejectPromise(webCallAbortError(options.signal));
      return;
    }
    if (remainingAtDispatch <= 0) {
      rejectPromise(new Error("The web call budget was exhausted before dispatch"));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.byteLength > WEB_EXTENSION_LIMITS.requestMaxBytes) {
      rejectPromise(new Error("The web request exceeds the 16 KiB request bound"));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: http.ClientRequest;
    const onAbort = () => {
      finish(webCallAbortError(options.signal));
      request.destroy();
    };
    const finish = (error?: Error, reply?: GatewayReply) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else if (reply) resolvePromise(reply);
    };
    request = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          accept: "application/json",
          // Hop metadata only: the remaining end-to-end budget, recomputed per hop.
          [WEB_EXTENSION_LIMITS.remainingHeader]: String(remainingAtDispatch),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > options.maxResponseBytes) {
            fail("The web gateway response exceeds the bound");
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          finish(undefined, { status: response.statusCode ?? 500, body: Buffer.concat(chunks) }),
        );
        response.on("error", () => fail("The web gateway response failed"));
      },
    );
    timer = setTimeout(() => {
      fail("The web call timed out");
      request.destroy();
    }, remainingAtDispatch);
    timer.unref?.();
    request.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (options.signal?.aborted) fail(webCallAbortError(options.signal).message);
      else if (settled) return;
      else fail(`The web gateway is unavailable: ${code ?? "unreachable"}`);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    request.end(body);
  });
}

/* ------------------------------ artifact store ------------------------------ */

export interface SavedArtifact {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly artifactTruncated: boolean;
}

/**
 * Per-attempt bookkeeping for exactly the filesystem entries this attempt created. Cleanup may
 * remove only entries registered here — anything else on disk belongs to a prior or concurrent
 * attempt and is never touched.
 */
interface ArtifactAttemptObserver {
  /** Called before a temp file is written, with its base name inside the attempt directory. */
  onTempFile?(name: string): void;
  /** Called immediately after an attempt file is atomically published (rename completed). */
  onPublished?(name: string): void;
}

/** Create-if-missing without following symlinks, then prove the result is a real directory. */
async function ensureOwnedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertRealDirectory(path);
}

async function assertRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("The web artifact path is not a real directory");
}

/**
 * Open (or reuse) the artifact directory for one stable tool call id. Every parent component is
 * validated BEFORE anything is created through it, so a hostile symlink can never cause writes
 * outside the Session store; a second page under the same id reuses the verified directory.
 */
async function openArtifactDirectory(cwd: string, toolCallId: string, signal?: AbortSignal): Promise<string> {
  if (!TOOL_ID_PATTERN.test(toolCallId)) {
    throw new Error("Unsafe web artifact tool id");
  }
  signal?.throwIfAborted();
  const root = await realpath(cwd);
  // Validate each component before creating through it (never mkdir -p across an unchecked link).
  await ensureOwnedDirectory(join(root, ".opentag"));
  await ensureOwnedDirectory(join(root, ".opentag", "web"));
  const baseReal = await realpath(join(root, ".opentag", "web"));
  if (!baseReal.startsWith(`${root}${sep}`)) throw new Error("The web artifact store escapes the workspace");
  const directory = join(baseReal, toolCallId);
  await ensureOwnedDirectory(directory);
  const resolvedDirectory = await realpath(directory);
  if (!resolvedDirectory.startsWith(`${baseReal}${sep}`)) {
    throw new Error("The web artifact directory escapes the Session store");
  }
  signal?.throwIfAborted();
  return resolvedDirectory;
}

/**
 * Save one page: bounded content, temp file + atomic rename, post-write regular-file proof.
 * The operation deadline stays authoritative after every await (including after publication), so
 * an aborted/timed-out attempt never reports a fabricated success. The observer is notified of the
 * temp name before the first write and of the published name right after the rename, which is the
 * only ownership evidence later cleanup is allowed to trust.
 * Throws on any failure — callers must mark the artifact unsaved and never fabricate a path.
 */
export async function saveWebArtifact(input: {
  cwd: string;
  toolCallId: string;
  fileName: string;
  content: string;
  signal?: AbortSignal;
  observer?: ArtifactAttemptObserver;
}): Promise<SavedArtifact> {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(input.fileName)) throw new Error("Unsafe web artifact file name");
  input.signal?.throwIfAborted();
  const directory = await openArtifactDirectory(input.cwd, input.toolCallId, input.signal);
  const truncated = truncateToByteBudget(input.content, WEB_EXTENSION_LIMITS.pageBodyMaxBytes);
  const bytes = Buffer.byteLength(truncated.text, "utf8");
  const sha256 = createHash("sha256").update(truncated.text, "utf8").digest("hex");
  const finalPath = join(directory, input.fileName);
  // An identical finalized page is immutable content: reuse it instead of rewriting, so a retry
  // can never replace bytes that the existing finalized index already references. Oversize or
  // unsafe entries are a bounded validation failure, never an unbounded read.
  const existing = await readBoundedRegularFile(finalPath, WEB_EXTENSION_LIMITS.pageBodyMaxBytes, input.signal);
  if (existing.kind === "oversize" || existing.kind === "unsafe") {
    throw new Error("The existing web artifact is not a bounded regular file");
  }
  if (existing.kind === "regular" && existing.bytes.length === bytes && sha256Hex(existing.bytes) === sha256) {
    return {
      relativePath: [".opentag", "web", input.toolCallId, input.fileName].join("/"),
      bytes,
      sha256,
      artifactTruncated: truncated.truncated,
    };
  }
  const tempName = `.${input.fileName}.${randomSuffix()}.tmp`;
  const tempPath = join(directory, tempName);
  input.observer?.onTempFile?.(tempName);
  try {
    // The operation signal is part of the actual write: an abort can stop the write itself, and the
    // post-await checks below still catch an abort that lands after completion.
    await writeFile(tempPath, truncated.text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
    await rename(tempPath, finalPath);
    input.observer?.onPublished?.(input.fileName);
    input.signal?.throwIfAborted();
    const stat = await lstat(finalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The web artifact failed verification");
    input.signal?.throwIfAborted();
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error instanceof Error ? error : new Error("The web artifact write failed");
  }
  return {
    relativePath: [".opentag", "web", input.toolCallId, input.fileName].join("/"),
    bytes,
    sha256,
    artifactTruncated: truncated.truncated,
  };
}

function randomSuffix(): string {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
}

interface FetchMetadataPage {
  index: number;
  url: string;
  file: string;
  bytes: number;
  sha256: string;
  artifactTruncated: boolean;
  upstreamTruncated: boolean | null;
  finalUrl: string | null;
  sourceFetchedAt: string | null;
  completeness: "unknown";
}

interface FetchMetadata {
  version: 1;
  toolCallId: string;
  requestId: string;
  retrievedAt: string;
  effectiveDepth: string;
  pages: FetchMetadataPage[];
  failures: Array<{ url: string; code: string; retryable: boolean }>;
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read cap for the attempt index: ample for three URLs plus failure records (URLs are bounded at
 * 4 KiB each), far below any allocation risk. Page content gets its own 1 MiB cap.
 */
const METADATA_READ_MAX_BYTES = 64 * 1024;
/** Fixed read chunk: the loop stops as soon as the cap is crossed, never trusting fstat size. */
const READ_CHUNK_BYTES = 64 * 1024;

type BoundedReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "regular"; readonly bytes: Buffer }
  | { readonly kind: "unsafe" }
  | { readonly kind: "oversize" };

/** Read-only, non-following, non-blocking open flags (POSIX bits fall back to 0 where absent). */
function boundedReadFlags(): number {
  const noFollow = (constants.O_NOFOLLOW as number | undefined) ?? 0;
  const nonBlocking = (constants.O_NONBLOCK as number | undefined) ?? 0;
  return constants.O_RDONLY | noFollow | nonBlocking;
}

/**
 * Bounded, symlink-safe read of a workspace-controlled entry. The handle is opened with
 * O_NOFOLLOW and O_NONBLOCK so a symlinked entry can never be followed and a FIFO can never block
 * the open waiting for a writer; fstat must prove a regular file, and the read proceeds in fixed
 * chunks until the cap is crossed — a file growing between fstat and read therefore returns
 * `oversize` instead of allocating past the cap. Callers decide whether a non-regular result is a
 * fall-through (cleanup) or a bounded unsaved failure (writes).
 */
async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedReadResult> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    // O_NONBLOCK makes an open of a FIFO return immediately so fstat can reject the non-regular
    // entry instead of blocking for a writer before the deadline and the type check run; it has
    // no effect on regular-file reads.
    handle = await open(path, boundedReadFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP" || code === "EMLINK") return { kind: "unsafe" };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "unsafe" };
    if (stat.size > maxBytes) return { kind: "oversize" };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return { kind: "oversize" };
      chunks.push(chunk.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    return { kind: "regular", bytes: Buffer.concat(chunks, total) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Files a finalized index references; malformed/absent metadata references nothing. */
function finalizedPagesFromBytes(bytes: Buffer): Set<string> {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as FetchMetadata;
    if (!parsed || !Array.isArray(parsed.pages)) return new Set();
    return new Set(parsed.pages.map((page) => page.file).filter((file) => typeof file === "string"));
  } catch {
    return new Set();
  }
}

async function finalizedFileSet(directory: string): Promise<Set<string>> {
  const existing = await readBoundedRegularFile(join(directory, "metadata.json"), METADATA_READ_MAX_BYTES);
  if (existing.kind !== "regular") return new Set();
  return finalizedPagesFromBytes(existing.bytes);
}

/**
 * Restore a prior finalized index atomically, and only over a regular file inside the validated
 * attempt directory. Best-effort: a restore failure never masks the original operation error.
 */
async function restoreMetadataBytes(directory: string, content: Buffer): Promise<void> {
  const target = join(directory, "metadata.json");
  const stat = await lstat(target).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
  const tempPath = join(directory, `.metadata.restore.${randomSuffix()}.tmp`);
  try {
    await writeFile(tempPath, content, { mode: 0o600, flag: "wx" });
    await rename(tempPath, target);
  } catch {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Which page names a surviving index protects. When this attempt published its own index and no
 * prior index is restored, its pages are its own to remove; otherwise pages referenced by the
 * surviving (prior or foreign) index must never be deleted.
 */
async function protectionSet(
  directory: string,
  input: { publishedMetadata?: boolean; priorMetadata?: Buffer },
): Promise<Set<string>> {
  if (input.publishedMetadata === true && input.priorMetadata !== undefined) {
    return finalizedPagesFromBytes(input.priorMetadata);
  }
  if (input.publishedMetadata === true) return new Set();
  return finalizedFileSet(directory);
}

/**
 * Decide the fate of the index this attempt published: put the prior finalized bytes back when
 * they are provably the ones we replaced, withdraw a fresh index of our own, and never clobber
 * an index that another attempt published after ours.
 */
async function settlePublishedMetadata(
  directory: string,
  input: { priorMetadata?: Buffer; publishedMetadataDigest?: string },
): Promise<void> {
  const digest = input.publishedMetadataDigest;
  if (digest === undefined) {
    await removeOwnedEntry(directory, "metadata.json");
    return;
  }
  const current = await readBoundedRegularFile(join(directory, "metadata.json"), METADATA_READ_MAX_BYTES);
  if (current.kind !== "regular" || sha256Hex(current.bytes) !== digest) return;
  if (input.priorMetadata !== undefined) {
    await restoreMetadataBytes(directory, input.priorMetadata);
    return;
  }
  await removeOwnedEntry(directory, "metadata.json");
}

/** A relative entry name that can only address one file directly inside the attempt directory. */
function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

/**
 * Resolve the attempt directory for cleanup without ever traversing a symlink: every component
 * (`.opentag`, `web`, the stable id) must be a real directory. A symlinked parent means this is
 * not the Session store this execution opened, so cleanup does nothing at all.
 */
async function resolveCleanupDirectory(cwd: string, toolCallId: string): Promise<string | undefined> {
  if (!TOOL_ID_PATTERN.test(toolCallId)) return undefined;
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return undefined;
  }
  const directory = join(root, ".opentag", "web", toolCallId);
  for (const component of [join(root, ".opentag"), join(root, ".opentag", "web"), directory]) {
    try {
      const stat = await lstat(component);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const resolved = await realpath(directory);
    if (!resolved.startsWith(`${root}${sep}`)) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

/** Remove one explicitly owned entry, and only when it is still a regular file (never a link). */
async function removeOwnedEntry(directory: string, name: string): Promise<void> {
  const target = join(directory, name);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
  } catch {
    return;
  }
  await rm(target, { force: true }).catch(() => undefined);
}

/**
 * Aborted/failed attempt cleanup: remove ONLY the entries this attempt explicitly registered —
 * the temp file names it reported before writing and the page files it published — and never a
 * wildcard `*.tmp` sweep. Anything else in the directory (another attempt's temp/publication
 * files, earlier successful artifacts, and pages protected by a surviving index) is preserved.
 * When this attempt published an index over a prior finalized one, the prior bytes are restored
 * unless another attempt has since published its own (proven by digest); a fresh index with no
 * prior is withdrawn. The whole path is validated first, so a symlinked intermediate component
 * cannot redirect the deletion outside the Session store.
 */
export async function cleanupWebArtifacts(input: {
  cwd: string;
  toolCallId: string;
  preExisting: ReadonlySet<string>;
  writtenThisAttempt: ReadonlySet<string>;
  /** Temp base names this attempt created before writing; the only temp names cleanup may remove. */
  tempFiles?: ReadonlySet<string>;
  /** True when this attempt published metadata.json: its index and pages are this attempt's. */
  publishedMetadata?: boolean;
  /** Finalized index bytes this attempt replaced; restored when the attempt is withdrawn. */
  priorMetadata?: Buffer;
  /** sha256 of the index bytes this attempt published, used to prove the on-disk index is ours. */
  publishedMetadataDigest?: string;
}): Promise<void> {
  const directory = await resolveCleanupDirectory(input.cwd, input.toolCallId);
  if (!directory) return;
  // Resolve protected page names before removing anything; a restored prior index is the survivor.
  const finalized = await protectionSet(directory, input);
  const owned = new Set<string>();
  for (const name of input.tempFiles ?? []) {
    if (isSafeEntryName(name)) owned.add(name);
  }
  for (const name of input.writtenThisAttempt) {
    if (!isSafeEntryName(name)) continue;
    if (input.preExisting.has(name)) continue;
    // A page a surviving finalized index references is not ours to delete.
    if (finalized.has(name)) continue;
    owned.add(name);
  }
  if (input.publishedMetadata) await settlePublishedMetadata(directory, input);
  await Promise.all([...owned].map((name) => removeOwnedEntry(directory, name)));
}

/**
 * Publish the attempt index. Like page writes, every await is followed by a deadline check:
 * cancellation while the temp file is being written must never rename metadata into place, and an
 * abort right after the rename is still surfaced to the caller. The caller then withdraws its own
 * index and restores the prior finalized bytes it captured before this rename.
 */
async function writeFetchMetadata(
  directory: string,
  serialized: string,
  signal?: AbortSignal,
  observer?: ArtifactAttemptObserver,
): Promise<void> {
  const finalPath = join(directory, "metadata.json");
  const tempName = `.metadata.json.${randomSuffix()}.tmp`;
  const tempPath = join(directory, tempName);
  signal?.throwIfAborted();
  observer?.onTempFile?.(tempName);
  try {
    // The operation signal is part of the actual write; the post-await checks still catch an
    // abort that lands after the write completes.
    await writeFile(tempPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      signal,
    });
    signal?.throwIfAborted();
    await rename(tempPath, finalPath);
    observer?.onPublished?.("metadata.json");
    signal?.throwIfAborted();
    const stat = await lstat(finalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The web metadata failed verification");
    signal?.throwIfAborted();
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error instanceof Error ? error : new Error("The web metadata write failed");
  }
}

/* ------------------------------- formatting ------------------------------- */

function searchOutput(result: Record<string, unknown>): { text: string; truncated: boolean } {
  const results = result.results as Record<string, unknown>[];
  const lines: string[] = [
    `web_search ok — ${results.length} source(s); requestId ${String(result.requestId)}; retrievedAt ${String(
      result.retrievedAt,
    )}; depth ${String(result.effectiveDepth)}.`,
    "Snippets are provider search snippets for source selection, not page content.",
  ];
  results.forEach((item, index) => {
    const published = typeof item.publishedAt === "string" ? `; published ${item.publishedAt}` : "";
    lines.push(
      `\n[${index + 1}] ${typeof item.title === "string" && item.title ? item.title : "(untitled)"}`,
      `URL: ${String(item.url)}${published}`,
      String(item.snippet ?? ""),
    );
  });
  return truncateToByteBudget(lines.join("\n"), WEB_EXTENSION_LIMITS.toolResultMaxBytes);
}

interface FetchItemView {
  status: string;
  url: string;
  finalUrl: string | null;
  content?: string;
  sourceFetchedAt?: string | null;
  upstreamTruncated?: boolean | null;
  previewTruncated?: boolean;
  artifactTruncated?: boolean;
  code?: string;
  retryable?: boolean;
}

interface FetchOutput {
  text: string;
  artifacts: SavedArtifact[];
  artifactWriteFailures: number;
  metadataWritten: boolean;
}

/** Details artifact records returned to Pi: same combined truncation flag as the metadata. */
function artifactDetails(
  artifacts: SavedArtifact[],
): Array<{ path: string; bytes: number; sha256: string; artifactTruncated: boolean }> {
  return artifacts.map((artifact) => ({
    path: artifact.relativePath,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    artifactTruncated: artifact.artifactTruncated,
  }));
}

/** Every requested URL failed: the batch is an operation failure, not a partial success. */
function allFailedError(items: FetchItemView[]): Error {
  const codes = items.map((item) => `${item.url}: ${String(item.code)}${item.retryable ? " (retryable)" : ""}`);
  return new Error(`web_fetch failed for every requested URL — ${truncateToByteBudget(codes.join("; "), 512).text}`);
}

/** One page's report section: metadata lines, flags, and the bounded preview. */
function pageSection(index: number, item: FetchItemView, content: string, saved: SavedArtifact | undefined): string[] {
  const preview = truncateToByteBudget(content, WEB_EXTENSION_LIMITS.previewPageMaxBytes);
  const flags: string[] = ["completeness unknown (extracted content, not raw HTML)"];
  if (preview.truncated || item.previewTruncated === true) flags.push("preview truncated");
  if (saved?.artifactTruncated || item.artifactTruncated === true) flags.push("stored content truncated");
  if (item.upstreamTruncated === true) flags.push("upstream truncated");
  if (item.upstreamTruncated === null || item.upstreamTruncated === undefined)
    flags.push("upstream truncation unknown");
  return [
    `\n[${index + 1}] ${item.url} — ${item.status}`,
    `finalUrl: ${item.finalUrl ?? "unknown"}; sourceFetchedAt: ${item.sourceFetchedAt ?? "unknown"}`,
    saved
      ? `saved: ${saved.relativePath} (${saved.bytes} bytes, sha256:${saved.sha256})`
      : "saved: none (artifact write failed; content exists only in this preview)",
    `flags: ${flags.join("; ")}`,
    "preview:",
    preview.text,
  ];
}

/** The attempt index, including the combined upstream + local truncation flag per page. */
function buildFetchMetadata(
  result: Record<string, unknown>,
  toolCallId: string,
  pages: Array<{ index: number; item: FetchItemView; artifact: SavedArtifact }>,
  results: FetchItemView[],
): FetchMetadata {
  return {
    version: 1,
    toolCallId,
    requestId: String(result.requestId),
    retrievedAt: String(result.retrievedAt),
    effectiveDepth: String(result.effectiveDepth),
    pages: pages.map((page) => ({
      index: page.index,
      url: page.item.url,
      file: page.artifact.relativePath.split("/").pop() ?? "",
      bytes: page.artifact.bytes,
      sha256: page.artifact.sha256,
      artifactTruncated: page.artifact.artifactTruncated,
      upstreamTruncated: page.item.upstreamTruncated ?? null,
      finalUrl: page.item.finalUrl ?? null,
      sourceFetchedAt: page.item.sourceFetchedAt ?? null,
      completeness: "unknown",
    })),
    failures: results
      .filter((item) => item.status === "failed")
      .map((item) => ({ url: item.url, code: String(item.code), retryable: item.retryable === true })),
  };
}

/** Save one non-failed page with the combined truncation flag; abort always propagates. */
async function saveOnePage(input: {
  cwd: string;
  toolCallId: string;
  index: number;
  item: FetchItemView;
  content: string;
  signal: AbortSignal;
  observer: ArtifactAttemptObserver;
}): Promise<{ saved?: SavedArtifact; writeFailed: boolean }> {
  try {
    const saved = await saveWebArtifact({
      cwd: input.cwd,
      toolCallId: input.toolCallId,
      fileName: `page-${input.index}.md`,
      content: input.content,
      signal: input.signal,
      observer: input.observer,
    });
    // The reported record carries the combined upstream + local truncation flag, matching the
    // metadata index; neither source of truncation may silently disappear from the details.
    return {
      saved: { ...saved, artifactTruncated: saved.artifactTruncated || input.item.artifactTruncated === true },
      writeFailed: false,
    };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { writeFailed: true };
  }
}

/**
 * Explicit per-attempt ownership ledger: only entries registered here (temp names before their
 * first write, published names after their rename, and the index this attempt published) may be
 * removed by cleanup — no wildcard tmp sweeps.
 */
interface AttemptLedger {
  readonly tempFiles: Set<string>;
  readonly writtenThisAttempt: Set<string>;
  readonly observer: ArtifactAttemptObserver;
  metadataPublished: boolean;
  /** sha256 of the index bytes this attempt renamed into place; undefined until then. */
  publishedMetadataDigest: string | undefined;
  /** Index bytes present immediately before this attempt's rename; restored on cancellation. */
  priorMetadata: Buffer | undefined;
}

function createAttemptLedger(): AttemptLedger {
  const tempFiles = new Set<string>();
  const writtenThisAttempt = new Set<string>();
  return {
    tempFiles,
    writtenThisAttempt,
    metadataPublished: false,
    publishedMetadataDigest: undefined,
    priorMetadata: undefined,
    observer: {
      onTempFile: (name) => {
        tempFiles.add(name);
      },
      onPublished: (name) => {
        writtenThisAttempt.add(name);
      },
    },
  };
}

function fetchHeader(result: Record<string, unknown>, results: FetchItemView[]): string {
  return `web_fetch ${String(result.status)} — ${results.length} URL result(s); requestId ${String(
    result.requestId,
  )}; retrievedAt ${String(result.retrievedAt)}; depth ${String(result.effectiveDepth)}.`;
}

/** Open the attempt store up front so pre-existing files are known before any write. */
async function openAttemptStore(
  cwd: string,
  toolCallId: string,
  signal: AbortSignal,
): Promise<{ directory: string; preExisting: Set<string> }> {
  const directory = await openArtifactDirectory(cwd, toolCallId, signal);
  const preExisting = new Set(await readdir(directory).catch(() => [] as string[]));
  return { directory, preExisting };
}

function failedPageSection(index: number, item: FetchItemView): string {
  return `\n[${index + 1}] ${item.url} — FAILED: ${String(item.code)}${item.retryable ? " (retryable with a new call)" : ""}`;
}

/**
 * Save every non-failed page for this attempt and build its report sections. A genuine write
 * failure is counted and reported; an abort always propagates so the caller never sees success.
 */
async function saveResultPages(
  results: FetchItemView[],
  toolCallId: string,
  cwd: string,
  signal: AbortSignal,
  ledger: AttemptLedger,
): Promise<{
  artifacts: SavedArtifact[];
  pages: Array<{ index: number; item: FetchItemView; artifact: SavedArtifact }>;
  sections: string[];
  artifactWriteFailures: number;
}> {
  const artifacts: SavedArtifact[] = [];
  const pages: Array<{ index: number; item: FetchItemView; artifact: SavedArtifact }> = [];
  const sections: string[] = [];
  let artifactWriteFailures = 0;
  for (const [index, item] of results.entries()) {
    signal.throwIfAborted();
    if (item.status === "failed") {
      sections.push(failedPageSection(index, item));
      continue;
    }
    const content = typeof item.content === "string" ? item.content : "";
    const { saved, writeFailed } = await saveOnePage({
      cwd,
      toolCallId,
      index,
      item,
      content,
      signal,
      observer: ledger.observer,
    });
    if (writeFailed) artifactWriteFailures += 1;
    if (saved) {
      artifacts.push(saved);
      pages.push({ index, item, artifact: saved });
    }
    sections.push(...pageSection(index, item, content, saved));
  }
  return { artifacts, pages, sections, artifactWriteFailures };
}

/**
 * Publish the attempt index. A cancellation during the temp write is rethrown (never a degraded
 * success); only a genuine non-abort write failure returns `failed: true`.
 */
async function publishAttemptMetadata(
  directory: string,
  result: Record<string, unknown>,
  toolCallId: string,
  pages: Array<{ index: number; item: FetchItemView; artifact: SavedArtifact }>,
  results: FetchItemView[],
  signal: AbortSignal,
  ledger: AttemptLedger,
): Promise<{ written: boolean; failed: boolean }> {
  const metadata = buildFetchMetadata(result, toolCallId, pages, results);
  const serialized = `${JSON.stringify(metadata, undefined, 2)}\n`;
  const digest = sha256Hex(Buffer.from(serialized, "utf8"));
  // Capture the index this rename replaces so a cancelled retry can put the prior index back. An
  // unreadable (unsafe/oversize) existing index fails the attempt before any rename: we never
  // overwrite an index that could not have been preserved.
  const prior = await readBoundedRegularFile(join(directory, "metadata.json"), METADATA_READ_MAX_BYTES, signal);
  if (prior.kind === "oversize" || prior.kind === "unsafe") {
    throw new Error("The existing web metadata is not a bounded regular file");
  }
  ledger.priorMetadata = prior.kind === "regular" ? prior.bytes : undefined;
  try {
    await writeFetchMetadata(directory, serialized, signal, {
      onTempFile: (name) => {
        ledger.tempFiles.add(name);
      },
      onPublished: () => {
        ledger.metadataPublished = true;
        ledger.publishedMetadataDigest = digest;
      },
    });
    return { written: true, failed: false };
  } catch (error) {
    if (signal.aborted) throw error;
    return { written: false, failed: true };
  }
}

async function cleanupAttempt(
  cwd: string,
  toolCallId: string,
  preExisting: ReadonlySet<string>,
  ledger: AttemptLedger,
): Promise<void> {
  await cleanupWebArtifacts({
    cwd,
    toolCallId,
    preExisting,
    writtenThisAttempt: ledger.writtenThisAttempt,
    tempFiles: ledger.tempFiles,
    publishedMetadata: ledger.metadataPublished,
    priorMetadata: ledger.priorMetadata,
    publishedMetadataDigest: ledger.publishedMetadataDigest,
  });
}

/** One final truncation covers framing AND suffix: the total never exceeds the tool bound. */
function assembleFetchText(sections: string[], artifactWriteFailures: number): string {
  const suffix =
    artifactWriteFailures > 0
      ? `\n${artifactWriteFailures} artifact write(s) failed; no fabricated paths are reported.`
      : "";
  return truncateToByteBudget(`${sections.join("\n")}${suffix}`, WEB_EXTENSION_LIMITS.toolResultMaxBytes).text;
}

async function fetchOutput(
  result: Record<string, unknown>,
  toolCallId: string,
  cwd: string,
  signal: AbortSignal,
): Promise<FetchOutput> {
  const results = result.results as FetchItemView[];
  const ledger = createAttemptLedger();
  const sections: string[] = [fetchHeader(result, results)];
  let directory: string | undefined;
  let preExisting = new Set<string>();
  try {
    signal.throwIfAborted();
    if (results.some((item) => item.status !== "failed")) {
      const store = await openAttemptStore(cwd, toolCallId, signal);
      directory = store.directory;
      preExisting = store.preExisting;
    }
    const pageOutcome = await saveResultPages(results, toolCallId, cwd, signal, ledger);
    sections.push(...pageOutcome.sections);
    signal.throwIfAborted();
    let artifactWriteFailures = pageOutcome.artifactWriteFailures;
    let metadataWritten = false;
    if (directory && pageOutcome.pages.length > 0) {
      const published = await publishAttemptMetadata(
        directory,
        result,
        toolCallId,
        pageOutcome.pages,
        results,
        signal,
        ledger,
      );
      metadataWritten = published.written;
      if (published.written) sections.push(`\nmetadata: ${".opentag"}/web/${toolCallId}/metadata.json`);
      else if (published.failed) {
        artifactWriteFailures += 1;
        sections.push("\nmetadata: write failed (page files above remain saved)");
      }
    }
    // Last check before reporting success: an abort that landed during the final publication still
    // fails the tool result and lets cleanup withdraw this attempt's metadata/pages.
    signal.throwIfAborted();
    return {
      text: assembleFetchText(sections, artifactWriteFailures),
      artifacts: pageOutcome.artifacts,
      artifactWriteFailures,
      metadataWritten,
    };
  } catch (error) {
    await cleanupAttempt(cwd, toolCallId, preExisting, ledger);
    throw error;
  }
}

/* ------------------------------ tool execution ----------------------------- */

function errorEnvelope(body: Buffer): { code: string; retryable: boolean } | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { error?: { code?: unknown; retryable?: unknown } };
    if (typeof parsed?.error?.code !== "string") return undefined;
    return { code: parsed.error.code, retryable: parsed.error.retryable === true };
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

const INVALID_WIRE_PAYLOAD = "The web gateway returned an invalid payload";

function invalidWirePayload(): Error {
  return new Error(INVALID_WIRE_PAYLOAD);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireBoundedString(value: unknown, maxBytes: number): string {
  if (!boundedString(value, maxBytes)) throw invalidWirePayload();
  return value;
}

function requireNonEmptyBoundedString(value: unknown, maxBytes: number): string {
  const text = requireBoundedString(value, maxBytes);
  if (text.length === 0) throw invalidWirePayload();
  return text;
}

/** Shared envelope: request id, retrieval time, depth, and the results array shape. */
function assertWireEnvelope(record: Record<string, unknown>): void {
  requireNonEmptyBoundedString(record.requestId, 128);
  requireBoundedString(record.retrievedAt, 64);
  if (record.effectiveDepth !== "basic" && record.effectiveDepth !== "advanced") throw invalidWirePayload();
  if (!Array.isArray(record.results)) throw invalidWirePayload();
}

function assertSearchWireItem(value: unknown): void {
  if (!isPlainRecord(value)) throw invalidWirePayload();
  requireNonEmptyBoundedString(value.sourceId, 128);
  requireBoundedString(value.title, 2048);
  requireNonEmptyBoundedString(value.url, WEB_EXTENSION_LIMITS.urlMaxBytes);
  requireBoundedString(value.snippet, 8192);
  if (value.publishedAt !== undefined && !boundedString(value.publishedAt, 128)) throw invalidWirePayload();
}

function assertFailedFetchWireItem(item: Record<string, unknown>): void {
  requireNonEmptyBoundedString(item.code, 64);
  if (typeof item.retryable !== "boolean") throw invalidWirePayload();
}

function assertContentFetchWireItem(item: Record<string, unknown>): void {
  if (item.status !== "ok" && item.status !== "partial") throw invalidWirePayload();
  if (item.contentKind !== "extracted" || item.completeness !== "unknown") throw invalidWirePayload();
  requireBoundedString(item.content, WEB_EXTENSION_LIMITS.pageBodyMaxBytes);
  if (item.finalUrl !== null && !boundedString(item.finalUrl, WEB_EXTENSION_LIMITS.urlMaxBytes)) {
    throw invalidWirePayload();
  }
  if (item.sourceFetchedAt !== null && !boundedString(item.sourceFetchedAt, 64)) throw invalidWirePayload();
  if (item.upstreamTruncated !== null && typeof item.upstreamTruncated !== "boolean") throw invalidWirePayload();
  if (typeof item.previewTruncated !== "boolean" || typeof item.artifactTruncated !== "boolean") {
    throw invalidWirePayload();
  }
}

function assertFetchWireItem(value: unknown): void {
  if (!isPlainRecord(value)) throw invalidWirePayload();
  requireNonEmptyBoundedString(value.url, WEB_EXTENSION_LIMITS.urlMaxBytes);
  if (value.status === "failed") {
    assertFailedFetchWireItem(value);
    return;
  }
  assertContentFetchWireItem(value);
}

function assertSearchWireResult(record: Record<string, unknown>, results: unknown[]): void {
  if (record.status !== "ok") throw invalidWirePayload();
  if (results.length > 25) throw invalidWirePayload();
  for (const item of results) assertSearchWireItem(item);
}

function assertFetchWireResult(record: Record<string, unknown>, results: unknown[]): void {
  if (!["ok", "partial", "failed"].includes(String(record.status))) throw invalidWirePayload();
  if (results.length > WEB_EXTENSION_LIMITS.fetchUrlsMax) throw invalidWirePayload();
  for (const item of results) assertFetchWireItem(item);
}

/**
 * Defensive wire validation (the trusted gateway/client hold the authoritative shared schemas).
 * Enough shape and bounds are checked here to prevent mislabeled or synthetic successes.
 */
function assertWireResult(value: unknown, kind: "search" | "fetch"): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalidWirePayload();
  assertWireEnvelope(value);
  const results = value.results as unknown[];
  if (kind === "search") assertSearchWireResult(value, results);
  else assertFetchWireResult(value, results);
  return value;
}

function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Results must correspond exactly to the requested URLs after documented normalization/dedup
 * (fragment removed, host case/default ports normalized): every item matches one unclaimed
 * request, none are missing, and duplicates never borrow another URL's content.
 */
function requestedUrlsMatch(urls: string[], results: FetchItemView[]): void {
  const expected = new Map<string, number>();
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (normalized) expected.set(normalized, (expected.get(normalized) ?? 0) + 1);
  }
  const seen = new Set<string>();
  for (const item of results) {
    const normalized = normalizeUrl(item.url);
    if (!normalized || !expected.has(normalized) || seen.has(normalized)) {
      throw new Error("The web gateway returned a result for an unrequested or duplicated URL");
    }
    seen.add(normalized);
  }
  if (seen.size !== expected.size) {
    throw new Error("The web gateway omitted a requested URL from the results");
  }
}

type GatewayOperation = "web_search" | "web_fetch";

/** Validate the HTTP status and parse a successful JSON reply; failures stay bounded/redacted. */
function requireWebSuccessReply(operation: GatewayOperation, reply: GatewayReply): Record<string, unknown> {
  if (reply.status !== 200) {
    const failure = errorEnvelope(reply.body);
    throw new Error(
      `${operation} failed: ${failure?.code ?? `http_${reply.status}`}${failure?.retryable ? " (retryable)" : ""}`,
    );
  }
  return JSON.parse(reply.body.toString("utf8")) as Record<string, unknown>;
}

interface SearchToolParams {
  query: string;
  limit?: number;
  domains?: string[];
  timeRange?: string;
  language?: string;
  depth?: string;
}

/** Optional search fields are included only when the caller supplied them. */
function searchRequestBody(toolCallId: string, params: SearchToolParams): Record<string, unknown> {
  return {
    protocolVersion: WEB_EXTENSION_LIMITS.protocolVersion,
    toolCallId,
    query: params.query,
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.domains ? { domains: params.domains } : {}),
    ...(params.timeRange ? { timeRange: params.timeRange } : {}),
    ...(params.language ? { language: params.language } : {}),
    depth: params.depth === "advanced" ? "advanced" : "basic",
  };
}

interface ExtensionTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export default function openTagWebTools(pi: { registerTool(tool: ExtensionTool): void }): void {
  const socketPath = process.env[ENDPOINT_ENV];
  // No endpoint descriptor: the trusted gateway is absent, so the tools must not register.
  if (!socketPath) return;

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web through OpenTag's managed provider. Returns bounded source snippets for selection; " +
      "use web_fetch on chosen URLs for page content. depth=advanced costs more and must be chosen explicitly. " +
      "No automatic retries; a failed call may be retried as a new explicit call when marked retryable.",
    parameters: WEB_SEARCH_PARAMETERS,
    async execute(runtimeToolCallId, rawParams, signal, _onUpdate, _ctx) {
      const params = rawParams as SearchToolParams;
      const toolCallId = deriveWebToolIdentity(socketPath, runtimeToolCallId);
      // The original 15s budget stays authoritative for the HTTP hop AND all formatting: the
      // deadline signal fires even if the gateway reply is already in flight.
      const deadline = startOperationDeadline(WEB_EXTENSION_LIMITS.searchTimeoutMs, signal);
      try {
        const reply = await postToGateway(socketPath, "/web/search", searchRequestBody(toolCallId, params), {
          deadlineAtMs: deadline.deadlineAtMs,
          signal: deadline.signal,
          maxResponseBytes: WEB_EXTENSION_LIMITS.searchResponseMaxBytes,
        });
        deadline.signal.throwIfAborted();
        const result = assertWireResult(requireWebSuccessReply("web_search", reply), "search");
        const output = searchOutput(result);
        deadline.signal.throwIfAborted();
        return {
          content: [{ type: "text" as const, text: output.text }],
          details: {
            requestId: String(result.requestId),
            status: "ok",
            sourceCount: (result.results as unknown[]).length,
            truncated: output.truncated,
          },
        };
      } finally {
        deadline.dispose();
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Extract page content for 1–3 public http(s) URLs through OpenTag's managed provider. Content is the " +
      "provider's extraction (not raw HTML; completeness unknown). Full pages are saved under the Session " +
      "workspace .opentag/web/ with sha256 metadata; previews are bounded. HTTP 200 can still contain per-URL " +
      "failures — read every item. depth=advanced costs more and must be chosen explicitly.",
    parameters: WEB_FETCH_PARAMETERS,
    async execute(runtimeToolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as { urls: string[]; depth?: string };
      const toolCallId = deriveWebToolIdentity(socketPath, runtimeToolCallId);
      // The original 45s budget covers the HTTP hop AND every artifact write/publication: the
      // deadline signal remains live after the reply and is the only signal fetchOutput trusts.
      const deadline = startOperationDeadline(WEB_EXTENSION_LIMITS.fetchTimeoutMs, signal);
      try {
        const reply = await postToGateway(
          socketPath,
          "/web/fetch",
          {
            protocolVersion: WEB_EXTENSION_LIMITS.protocolVersion,
            toolCallId,
            urls: params.urls,
            depth: params.depth === "advanced" ? "advanced" : "basic",
          },
          {
            deadlineAtMs: deadline.deadlineAtMs,
            signal: deadline.signal,
            maxResponseBytes: WEB_EXTENSION_LIMITS.fetchResponseMaxBytes,
          },
        );
        deadline.signal.throwIfAborted();
        const result = assertWireResult(requireWebSuccessReply("web_fetch", reply), "fetch");
        const items = result.results as FetchItemView[];
        requestedUrlsMatch(params.urls, items);
        if (items.length === 0 || items.every((item) => item.status === "failed")) {
          // An all-failed batch is an operation failure: Pi must record toolResult.isError=true.
          throw allFailedError(items);
        }
        const output = await fetchOutput(result, toolCallId, ctx.cwd, deadline.signal);
        // A late cancellation/deadline must never resolve a successful tool result.
        deadline.signal.throwIfAborted();
        return {
          content: [{ type: "text" as const, text: output.text }],
          details: {
            requestId: String(result.requestId),
            status: String(result.status),
            artifacts: artifactDetails(output.artifacts),
            artifactWriteFailures: output.artifactWriteFailures,
            metadataWritten: output.metadataWritten,
          },
        };
      } finally {
        deadline.dispose();
      }
    },
  });
}
