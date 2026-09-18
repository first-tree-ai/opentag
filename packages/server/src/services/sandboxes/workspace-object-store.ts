import { randomUUID } from "node:crypto";
import {
  RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES,
  RUNNER_WORKSPACE_TIMEOUT_MS,
  type RunnerWorkspaceObject,
  redactForLog,
} from "@opentag/shared";
import { readBoundedJson } from "../cloud-run/bounded-json.js";
import type { AccessTokenProvider } from "../cloud-run/token-provider.js";

/**
 * E5 workspace persistence: exactly one latest GCS object (`<storage_uri>/state.tar.gz`) per
 * Sandbox; no listing, versioning or checkpoint database. Fencing is native GCS
 * generation+metageneration compare-and-swap on every mutation: `claim`'s conditional PATCH bumps
 * the metageneration, so an old executor's in-flight conditional upload fails at commit time.
 * Uploads are single-request multipart inserts (conditions bind when the full body arrives), never
 * resumable sessions. The Google access token never leaves the Server; upstream error bodies are
 * never read, and typed errors carry sanitized messages only. The parent wires auth/DB/HTTP.
 */

export interface WorkspaceObjectScope {
  storageUri: string;
  sandboxId: string;
  sessionId: string;
  environmentGeneration: number;
}

/** A validated snapshot of the latest object; the shared Runner workspace contract. */
export type WorkspaceObject = RunnerWorkspaceObject;

export interface WorkspaceObjectWriteInput {
  body: AsyncIterable<Uint8Array>;
  bytes: number;
  sha256: string;
  md5: string;
  sealed: boolean;
}

export interface WorkspaceObjectStore {
  /** Initialization is reserved for the Server before its first allocation; Runner claims never seed. */
  claim(scope: WorkspaceObjectScope, options?: { initialize?: boolean }): Promise<WorkspaceObject>;
  head(scope: WorkspaceObjectScope): Promise<WorkspaceObject | undefined>;
  read(scope: WorkspaceObjectScope, object: WorkspaceObject): Promise<ReadableStream<Uint8Array>>;
  write(
    scope: WorkspaceObjectScope,
    previous: WorkspaceObject,
    input: WorkspaceObjectWriteInput,
  ): Promise<WorkspaceObject>;
}

export type WorkspaceObjectStoreErrorCode =
  | "invalid_uri"
  | "invalid_scope"
  | "invalid_input"
  | "missing"
  | "corrupt"
  | "owner_mismatch"
  | "stale"
  | "sealed"
  | "conflict"
  | "changed"
  | "credential"
  | "timeout"
  | "unavailable"
  | "unknown_result";

/** Sanitized adapter failure: bounded, redacted message; no upstream bodies or credentials. */
export class WorkspaceObjectStoreError extends Error {
  readonly code: WorkspaceObjectStoreErrorCode;
  readonly status?: number;

  constructor(code: WorkspaceObjectStoreErrorCode, message: string, options: { status?: number } = {}) {
    super(sanitizeMessage(message));
    this.name = "WorkspaceObjectStoreError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

const MESSAGE_MAX_CHARS = 256;
const API_BASE = "https://storage.googleapis.com/storage/v1";
const UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1";
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_CLAIM_ATTEMPTS = 5;
const METADATA_RESPONSE_LIMIT = 64 * 1024;
const STORAGE_URI_MAX_LENGTH = 2048;
const MAX_GENERATION_VALUE = 9_999_999_999;
const OBJECT_NAME = "state.tar.gz";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_MD5 = "1B2M2Y8AsgTpgAmY7PhCfg==";

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const GENERATION_PATTERN = /^[1-9][0-9]{0,18}$/;
const OWNER_PATTERN = /^[1-9][0-9]{0,9}$/;
const SIZE_PATTERN = /^(0|[1-9][0-9]{0,9})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MD5_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

const META_SCHEMA = "schema";
const META_SANDBOX = "sandbox";
const META_SESSION = "session";
const META_OWNER = "owner";
const META_SAVED = "saved";
const META_SEALED = "sealed";
const META_SHA256 = "sha256";
const METADATA_KEYS = new Set([
  META_SCHEMA,
  META_SANDBOX,
  META_SESSION,
  META_OWNER,
  META_SAVED,
  META_SEALED,
  META_SHA256,
]);

const CLAIM_RETRYABLE = new Set<WorkspaceObjectStoreErrorCode>([
  "conflict",
  "timeout",
  "unavailable",
  "unknown_result",
]);

interface ObjectLocation {
  bucket: string;
  object: string;
}

/** Validated snapshot; identical to the wire contract once identity checks passed. */
type StoredSnapshot = RunnerWorkspaceObject;

function sanitizeMessage(message: string): string {
  return redactForLog(message.slice(0, MESSAGE_MAX_CHARS * 2))
    .replaceAll("\n", " ")
    .slice(0, MESSAGE_MAX_CHARS);
}

function fail(code: WorkspaceObjectStoreErrorCode, message: string): never {
  throw new WorkspaceObjectStoreError(code, message);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertScopeIdentity(scope: WorkspaceObjectScope): void {
  if (!ID_PATTERN.test(scope.sandboxId) || !ID_PATTERN.test(scope.sessionId)) {
    fail("invalid_scope", "Sandbox or Session identity is outside the durable identity shape");
  }
  if (
    !Number.isSafeInteger(scope.environmentGeneration) ||
    scope.environmentGeneration < 1 ||
    scope.environmentGeneration > MAX_GENERATION_VALUE
  ) {
    fail("invalid_scope", "Environment generation must be a positive bounded integer");
  }
}

/** Strictly parses the fixed `gs://bucket/prefix/sandbox-id` URI and derives the one object name. */
function locationFor(scope: WorkspaceObjectScope): ObjectLocation {
  assertScopeIdentity(scope);
  const uri = scope.storageUri;
  if (typeof uri !== "string" || uri.length === 0 || uri.length > STORAGE_URI_MAX_LENGTH) {
    fail("invalid_uri", "Storage URI exceeds the durable address bound");
  }
  if (!uri.startsWith("gs://")) fail("invalid_uri", "Storage URI must use the gs:// scheme");
  // No query, fragment or credentials; the charset below also excludes them per segment.
  if (uri.includes("?") || uri.includes("#") || uri.includes("@")) {
    fail("invalid_uri", "Storage URI must not carry a query, fragment or credentials");
  }
  const rest = uri.slice("gs://".length);
  const slash = rest.indexOf("/");
  if (slash < 1) fail("invalid_uri", "Storage URI must name a bucket and a workspace prefix");
  const bucket = rest.slice(0, slash);
  const prefix = rest.slice(slash + 1);
  if (!BUCKET_PATTERN.test(bucket)) fail("invalid_uri", "Storage URI bucket name is not a valid GCS bucket");
  if (prefix.length === 0 || prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("//")) {
    fail("invalid_uri", "Storage URI prefix is malformed");
  }
  const segments = prefix.split("/");
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      fail("invalid_uri", "Storage URI prefix carries an unsafe segment");
    }
  }
  if (segments[segments.length - 1] !== scope.sandboxId) {
    fail("invalid_uri", "Storage URI does not end with the Sandbox id it scopes");
  }
  return { bucket, object: `${prefix}/${OBJECT_NAME}` };
}

function metadataUrl(location: ObjectLocation): string {
  return `${API_BASE}/b/${location.bucket}/o/${encodeURIComponent(location.object)}`;
}

function assertStorageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail("invalid_uri", "Internal GCS request URL construction failed");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "storage.googleapis.com" ||
    parsed.username ||
    parsed.password
  ) {
    fail("invalid_uri", "Refusing to contact an origin outside storage.googleapis.com");
  }
}

function metadataFor(
  scope: WorkspaceObjectScope,
  state: { ownerGeneration: number; saved: boolean; sealed: boolean; sha256: string },
): Record<string, string> {
  return {
    [META_SCHEMA]: "1",
    [META_SANDBOX]: scope.sandboxId,
    [META_SESSION]: scope.sessionId,
    [META_OWNER]: String(state.ownerGeneration),
    [META_SAVED]: state.saved ? "true" : "false",
    [META_SEALED]: state.sealed ? "true" : "false",
    [META_SHA256]: state.sha256,
  };
}

/** Strictly validates an Objects resource before trusting any of it; identity must match the scope. */
function parseSnapshot(resource: unknown, location: ObjectLocation, scope: WorkspaceObjectScope): StoredSnapshot {
  const body = record(resource);
  if (body.name !== location.object || body.bucket !== location.bucket) {
    fail("corrupt", "GCS object identity does not match the Workspace location");
  }
  const { generation, metageneration, size, md5Hash } = body;
  if (
    typeof generation !== "string" ||
    !GENERATION_PATTERN.test(generation) ||
    typeof metageneration !== "string" ||
    !GENERATION_PATTERN.test(metageneration)
  ) {
    fail("corrupt", "GCS object generations are not opaque decimal strings");
  }
  if (typeof size !== "string" || !SIZE_PATTERN.test(size)) fail("corrupt", "GCS object size is not a decimal string");
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes > RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES) {
    fail("corrupt", "GCS object size exceeds the Workspace archive bound");
  }
  if (typeof md5Hash !== "string" || !MD5_PATTERN.test(md5Hash)) {
    fail("corrupt", "GCS object md5Hash is not a base64 digest");
  }
  return parseCustomMetadata(record(body.metadata), scope, { generation, metageneration, bytes, md5: md5Hash });
}

function parseCustomMetadata(
  metadata: Record<string, unknown>,
  scope: WorkspaceObjectScope,
  base: { generation: string; metageneration: string; bytes: number; md5: string },
): StoredSnapshot {
  const keys = Object.keys(metadata);
  if (keys.length !== METADATA_KEYS.size || !keys.every((key) => METADATA_KEYS.has(key))) {
    fail("corrupt", "GCS object metadata does not match the Workspace schema keys");
  }
  if (metadata[META_SCHEMA] !== "1") fail("corrupt", "Workspace object schema is unsupported");
  if (metadata[META_SANDBOX] !== scope.sandboxId || metadata[META_SESSION] !== scope.sessionId) {
    fail("owner_mismatch", "Workspace object belongs to a different Sandbox or Session");
  }
  const owner = metadata[META_OWNER];
  if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
    fail("corrupt", "Workspace object owner generation is not a decimal string");
  }
  const ownerGeneration = Number(owner);
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1 || ownerGeneration > MAX_GENERATION_VALUE) {
    fail("corrupt", "Workspace object owner generation is outside the valid bound");
  }
  const saved = metadata[META_SAVED];
  const sealed = metadata[META_SEALED];
  if ((saved !== "true" && saved !== "false") || (sealed !== "true" && sealed !== "false")) {
    fail("corrupt", "Workspace object saved/sealed flags are not booleans");
  }
  const sha256 = metadata[META_SHA256];
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    fail("corrupt", "Workspace object sha256 is not a hex digest");
  }
  return {
    generation: base.generation,
    metageneration: base.metageneration,
    ownerGeneration,
    saved: saved === "true",
    sealed: sealed === "true",
    bytes: base.bytes,
    sha256,
    md5: base.md5,
  };
}

function assertSnapshotInput(object: WorkspaceObject): void {
  if (!object || typeof object !== "object") fail("invalid_input", "Workspace object snapshot is required");
  if (!GENERATION_PATTERN.test(object.generation) || !GENERATION_PATTERN.test(object.metageneration)) {
    fail("invalid_input", "Workspace object generations are not opaque decimal strings");
  }
  if (
    !Number.isSafeInteger(object.ownerGeneration) ||
    object.ownerGeneration < 1 ||
    object.ownerGeneration > MAX_GENERATION_VALUE
  ) {
    fail("invalid_input", "Workspace object owner generation is outside the valid bound");
  }
  if (!Number.isSafeInteger(object.bytes) || object.bytes < 0 || object.bytes > RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES) {
    fail("invalid_input", "Workspace object byte length is outside the valid bound");
  }
  if (!SHA256_PATTERN.test(object.sha256) || !MD5_PATTERN.test(object.md5)) {
    fail("invalid_input", "Workspace object checksums are malformed");
  }
  if (typeof object.saved !== "boolean" || typeof object.sealed !== "boolean") {
    fail("invalid_input", "Workspace object flags are not booleans");
  }
}

function snapshotsEqual(snapshot: StoredSnapshot, object: WorkspaceObject): boolean {
  return (
    snapshot.generation === object.generation &&
    snapshot.metageneration === object.metageneration &&
    snapshot.ownerGeneration === object.ownerGeneration &&
    snapshot.saved === object.saved &&
    snapshot.sealed === object.sealed &&
    snapshot.bytes === object.bytes &&
    snapshot.sha256 === object.sha256 &&
    snapshot.md5 === object.md5
  );
}

function validateWriteInput(input: WorkspaceObjectWriteInput): void {
  if (!input || typeof input !== "object") fail("invalid_input", "Workspace write input is required");
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES) {
    fail("invalid_input", "Workspace archive byte length is zero or outside the 128 MiB bound");
  }
  if (!SHA256_PATTERN.test(input.sha256)) fail("invalid_input", "Workspace archive sha256 is not a hex digest");
  if (!MD5_PATTERN.test(input.md5)) fail("invalid_input", "Workspace archive md5 is not a base64 digest");
  if (typeof input.sealed !== "boolean") fail("invalid_input", "Workspace archive seal flag is not a boolean");
  const body = input.body as Partial<AsyncIterable<Uint8Array>> | undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    fail("invalid_input", "Workspace archive body must be an AsyncIterable of bytes");
  }
}

function cancelQuietly(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  // The seed object is zero bytes by definition.
}

/**
 * Frames the multipart/related body: JSON metadata part, exact content bytes, closing boundary.
 * The source must yield exactly `declaredBytes`; any violation errors the stream before the
 * epilogue is sent, so the request is truncated and can never commit server-side.
 */
async function* framedMultipart(
  source: AsyncIterable<Uint8Array>,
  declaredBytes: number,
  preamble: Uint8Array,
  epilogue: Uint8Array,
): AsyncGenerator<Uint8Array> {
  yield preamble;
  let sent = 0;
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    sent += chunk.byteLength;
    if (sent > declaredBytes) fail("invalid_input", "Workspace archive source exceeded its declared length");
    yield chunk;
  }
  if (sent !== declaredBytes) fail("invalid_input", "Workspace archive source is shorter than declared");
  yield epilogue;
}

/** Pull-based ReadableStream over an async iterable; cancellation reaches the source iterator. */
function readableFromAsyncIterable(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // A rejected next() may leave a non-generator source iterator open; close it explicitly.
        try {
          await iterator.return?.();
        } catch {
          // Iterator cleanup must never mask the original outcome.
        }
        controller.error(
          error instanceof WorkspaceObjectStoreError
            ? error
            : new WorkspaceObjectStoreError("invalid_input", "Workspace archive source stream failed"),
        );
      }
    },
    async cancel(reason) {
      try {
        await iterator.return?.(reason);
      } catch {
        // Iterator cleanup must never mask the original outcome.
      }
    },
  });
}

/** Bounds a media stream to exactly `expected` bytes; errors on truncation or overflow. */
function exactByteStream(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  let finished = false;
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          if (seen !== expected) fail("corrupt", "Workspace archive stream ended before the expected byte count");
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > expected) {
          finished = true;
          await reader.cancel().catch(() => undefined);
          fail("corrupt", "Workspace archive stream exceeded the expected byte count");
        }
        controller.enqueue(value);
      } catch (error) {
        finished = true;
        controller.error(streamReadError(error));
      } finally {
        if (finished) release();
      }
    },
    async cancel(reason) {
      finished = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation is best-effort; the deadline bounds any residue.
      } finally {
        release();
      }
    },
  });
}

function streamReadError(error: unknown): WorkspaceObjectStoreError {
  if (error instanceof WorkspaceObjectStoreError) return error;
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new WorkspaceObjectStoreError("timeout", "Workspace archive read exceeded its deadline");
  }
  return new WorkspaceObjectStoreError("unavailable", "Workspace archive stream failed mid-read");
}

export interface GcsWorkspaceObjectStoreOptions {
  tokenProvider: AccessTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GcsWorkspaceObjectStore implements WorkspaceObjectStore {
  readonly #tokenProvider: AccessTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GcsWorkspaceObjectStoreOptions) {
    const timeoutMs = options.timeoutMs ?? RUNNER_WORKSPACE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new WorkspaceObjectStoreError("invalid_input", "timeoutMs must be a positive bounded integer");
    }
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Advance ownership to the requested generation. Only an explicit initialization before
   * allocation 1 may seed an empty object (`ifGenerationMatch=0`); every restore of a missing
   * object fails closed, even in generation 1. Ownership advances via a
   * generation+metageneration PATCH that keeps content, checksums and `saved`; conflicts re-read
   * with bounded retries and never regress the owner.
   */
  async claim(scope: WorkspaceObjectScope, options: { initialize?: boolean } = {}): Promise<WorkspaceObject> {
    const location = locationFor(scope);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#claimAttempt(location, scope, options.initialize === true);
      } catch (error) {
        const retryable =
          error instanceof WorkspaceObjectStoreError &&
          CLAIM_RETRYABLE.has(error.code) &&
          attempt + 1 < MAX_CLAIM_ATTEMPTS;
        if (!retryable) throw error;
      }
    }
  }

  async #claimAttempt(
    location: ObjectLocation,
    scope: WorkspaceObjectScope,
    initialize: boolean,
  ): Promise<WorkspaceObject> {
    const current = await this.#getMetadata(location, scope, AbortSignal.timeout(this.#timeoutMs));
    if (current === undefined) {
      if (!initialize || scope.environmentGeneration !== 1) {
        fail("missing", "The expected workspace archive is absent");
      }
      return this.#insertSeed(location, scope);
    }
    if (current.ownerGeneration > scope.environmentGeneration) {
      fail("stale", "Workspace is owned by a newer environment generation");
    }
    if (current.ownerGeneration === scope.environmentGeneration) return current;
    return this.#patchOwner(location, scope, current, scope.environmentGeneration);
  }

  /** Returns the current validated snapshot, or undefined when no object exists yet. */
  async head(scope: WorkspaceObjectScope): Promise<WorkspaceObject | undefined> {
    const location = locationFor(scope);
    const current = await this.#getMetadata(location, scope, AbortSignal.timeout(this.#timeoutMs));
    return current === undefined ? undefined : current;
  }

  /**
   * Streams the archive pinned to the claimed generation (a replaced object fails instead of
   * silently reading latest). One deadline covers metadata, headers and the whole consumption;
   * the stream yields exactly the expected byte count.
   */
  async read(scope: WorkspaceObjectScope, object: WorkspaceObject): Promise<ReadableStream<Uint8Array>> {
    const location = locationFor(scope);
    assertSnapshotInput(object);
    if (object.ownerGeneration !== scope.environmentGeneration) {
      fail("stale", "Workspace object belongs to another environment generation; claim first");
    }
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const current = await this.#getMetadata(location, scope, deadline);
    if (current === undefined) fail("missing", "Workspace archive object is absent");
    if (!snapshotsEqual(current, object)) {
      fail("changed", "Workspace object changed since the claimed snapshot");
    }
    const response = await this.#send("GET", `${metadataUrl(location)}?alt=media&generation=${object.generation}`, {
      signal: deadline,
    });
    if (response.status === 404 || response.status === 410) {
      cancelQuietly(response);
      fail("changed", "Workspace object generation is gone; refusing to read latest");
    }
    if (!response.ok) throw this.#httpError(response, "read");
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && contentLength !== String(object.bytes)) {
      cancelQuietly(response);
      fail("corrupt", "Workspace archive media length disagrees with its metadata");
    }
    if (!response.body) {
      fail("unavailable", "Workspace archive media response carried no body");
    }
    return exactByteStream(response.body, object.bytes);
  }

  /**
   * Atomically replaces the latest object via a conditional multipart insert; the supplied md5Hash
   * lets GCS verify the received content. Uncertain outcomes (transport failure, HTTP 5xx, an
   * undecodable success response) are settled by read-back: success only when the latest object is
   * exactly the intended one under a new generation; the write is never retried unconditionally.
   */
  async write(
    scope: WorkspaceObjectScope,
    previous: WorkspaceObject,
    input: WorkspaceObjectWriteInput,
  ): Promise<WorkspaceObject> {
    const location = locationFor(scope);
    assertSnapshotInput(previous);
    validateWriteInput(input);
    if (previous.ownerGeneration !== scope.environmentGeneration) {
      fail("stale", "Workspace object belongs to another environment generation; claim first");
    }
    if (previous.sealed) fail("sealed", "Workspace archive is sealed; refusing any further write");
    const current = await this.#getMetadata(location, scope, AbortSignal.timeout(this.#timeoutMs));
    if (current === undefined) fail("missing", "Workspace archive object is absent; restoration is required");
    if (current.ownerGeneration !== scope.environmentGeneration) {
      fail("stale", "Workspace snapshot owner changed; claim again before writing");
    }
    if (current.generation !== previous.generation || current.metageneration !== previous.metageneration) {
      fail("conflict", "Workspace object changed since the claimed snapshot");
    }
    const metadata = metadataFor(scope, {
      ownerGeneration: scope.environmentGeneration,
      saved: true,
      sealed: input.sealed,
      sha256: input.sha256,
    });
    const conditions = `ifGenerationMatch=${previous.generation}&ifMetagenerationMatch=${previous.metageneration}`;
    let snapshot: StoredSnapshot;
    try {
      snapshot = await this.#insertMultipart(location, scope, metadata, input.md5, input.bytes, input.body, conditions);
    } catch (error) {
      if (error instanceof WorkspaceObjectStoreError && error.code === "unknown_result") {
        return this.#verifyWrite(location, scope, previous, input);
      }
      throw error;
    }
    if (this.#matchesAttempt(snapshot, scope, previous, input)) return snapshot;
    return this.#verifyWrite(location, scope, previous, input);
  }

  #matchesAttempt(
    snapshot: StoredSnapshot,
    scope: WorkspaceObjectScope,
    previous: WorkspaceObject,
    input: WorkspaceObjectWriteInput,
  ): boolean {
    return (
      snapshot.generation !== previous.generation &&
      snapshot.ownerGeneration === scope.environmentGeneration &&
      snapshot.saved &&
      snapshot.sealed === input.sealed &&
      snapshot.bytes === input.bytes &&
      snapshot.sha256 === input.sha256 &&
      snapshot.md5 === input.md5
    );
  }

  /** Read-back verification after an uncertain upload: success only on an exact attempted match. */
  async #verifyWrite(
    location: ObjectLocation,
    scope: WorkspaceObjectScope,
    previous: WorkspaceObject,
    input: WorkspaceObjectWriteInput,
  ): Promise<WorkspaceObject> {
    let current: StoredSnapshot | undefined;
    try {
      current = await this.#getMetadata(location, scope, AbortSignal.timeout(this.#timeoutMs));
    } catch {
      fail("unknown_result", "Workspace write outcome is uncertain and verification could not read the object");
    }
    if (current !== undefined && this.#matchesAttempt(current, scope, previous, input)) return current;
    fail("unknown_result", "Workspace write outcome is uncertain and did not verify against the latest object");
  }

  /** GET object metadata; 404 → undefined; strict validation otherwise. */
  async #getMetadata(
    location: ObjectLocation,
    scope: WorkspaceObjectScope,
    signal: AbortSignal,
  ): Promise<StoredSnapshot | undefined> {
    const response = await this.#send("GET", metadataUrl(location), { signal });
    if (response.status === 404) {
      cancelQuietly(response);
      return undefined;
    }
    if (!response.ok) throw this.#httpError(response, "inspect");
    return parseSnapshot(await this.#boundedJson(response), location, scope);
  }

  /** Conditional metadata PATCH advancing the owner and clearing the seal; content is untouched. */
  async #patchOwner(
    location: ObjectLocation,
    scope: WorkspaceObjectScope,
    current: StoredSnapshot,
    nextOwner: number,
  ): Promise<StoredSnapshot> {
    // The full validated metadata map is resent so the result is identical whether GCS merges or
    // replaces custom metadata under PATCH semantics.
    const metadata = metadataFor(scope, {
      ownerGeneration: nextOwner,
      saved: current.saved,
      sealed: false,
      sha256: current.sha256,
    });
    const url = `${metadataUrl(location)}?ifGenerationMatch=${current.generation}&ifMetagenerationMatch=${current.metageneration}`;
    const response = await this.#send("PATCH", url, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status === 404) {
      cancelQuietly(response);
      fail("conflict", "Workspace object changed during claim; re-reading");
    }
    if (!response.ok) throw this.#httpError(response, "claim");
    let parsed: unknown;
    try {
      parsed = await this.#boundedJson(response);
    } catch {
      fail("unknown_result", "Workspace claim response could not be decoded; re-reading");
    }
    let snapshot: StoredSnapshot;
    try {
      snapshot = parseSnapshot(parsed, location, scope);
    } catch {
      fail("unknown_result", "Workspace claim response did not parse; re-reading");
    }
    if (
      snapshot.generation !== current.generation ||
      snapshot.ownerGeneration !== nextOwner ||
      snapshot.sealed ||
      snapshot.saved !== current.saved ||
      snapshot.bytes !== current.bytes ||
      snapshot.sha256 !== current.sha256 ||
      snapshot.md5 !== current.md5
    ) {
      fail("unknown_result", "Workspace claim response did not match the patched snapshot; re-reading");
    }
    return snapshot;
  }

  /** Seeds the zero-byte object for the first generation (`ifGenerationMatch=0`). */
  async #insertSeed(location: ObjectLocation, scope: WorkspaceObjectScope): Promise<StoredSnapshot> {
    const metadata = metadataFor(scope, { ownerGeneration: 1, saved: false, sealed: false, sha256: EMPTY_SHA256 });
    const snapshot = await this.#insertMultipart(
      location,
      scope,
      metadata,
      EMPTY_MD5,
      0,
      emptyBody(),
      "ifGenerationMatch=0",
    );
    if (
      snapshot.ownerGeneration !== 1 ||
      snapshot.saved ||
      snapshot.sealed ||
      snapshot.bytes !== 0 ||
      snapshot.sha256 !== EMPTY_SHA256 ||
      snapshot.md5 !== EMPTY_MD5
    ) {
      fail("unknown_result", "Workspace seed response did not match the empty object; re-reading");
    }
    return snapshot;
  }

  /**
   * Single-request multipart upload with native generation/metageneration preconditions. Transport
   * failures and HTTP 5xx leave the outcome open (the conditional write may have committed), so
   * they surface as `unknown_result`; the caller verifies by read-back instead of retrying.
   */
  async #insertMultipart(
    location: ObjectLocation,
    scope: WorkspaceObjectScope,
    metadata: Record<string, string>,
    md5: string,
    bytes: number,
    body: AsyncIterable<Uint8Array>,
    conditionQuery: string,
  ): Promise<StoredSnapshot> {
    const boundary = `ot-${randomUUID().replaceAll("-", "")}`;
    const resource = JSON.stringify({
      name: location.object,
      contentType: "application/octet-stream",
      md5Hash: md5,
      metadata,
    });
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${resource}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const stream = readableFromAsyncIterable(framedMultipart(body, bytes, preamble, epilogue));
    const url = `${UPLOAD_BASE}/b/${location.bucket}/o?uploadType=multipart&${conditionQuery}`;
    let response: Response;
    try {
      response = await this.#send("POST", url, {
        headers: {
          "content-type": `multipart/related; boundary=${boundary}`,
          "content-length": String(preamble.byteLength + bytes + epilogue.byteLength),
        },
        body: stream,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof WorkspaceObjectStoreError) {
        // Preserve a direct framing error when the transport exposes it. Undici may instead
        // wrap a body-stream failure in TypeError, so that path conservatively uses read-back.
        if (error.code === "invalid_input") throw error;
        if (error.code === "timeout" || error.code === "unavailable") {
          fail("unknown_result", "Workspace upload outcome is uncertain; read-back verification required");
        }
      }
      throw error;
    }
    if (!response.ok) {
      // A 5xx may mask a committed overwrite (the response was lost after commit); only 4xx
      // preconditions and validations are definitive rejections.
      if (response.status >= 500) {
        cancelQuietly(response);
        fail("unknown_result", "Workspace upload outcome is uncertain; read-back verification required");
      }
      throw this.#httpError(response, "upload");
    }
    let parsed: unknown;
    try {
      parsed = await this.#boundedJson(response);
    } catch {
      fail("unknown_result", "Workspace upload response could not be decoded; read-back verification required");
    }
    try {
      return parseSnapshot(parsed, location, scope);
    } catch {
      fail("unknown_result", "Workspace upload response did not parse; read-back verification required");
    }
  }

  async #boundedJson(response: Response): Promise<unknown> {
    try {
      return await readBoundedJson(response, METADATA_RESPONSE_LIMIT);
    } catch {
      fail("unavailable", "GCS response could not be decoded within bounds");
    }
  }

  async #send(
    method: "GET" | "POST" | "PATCH",
    url: string,
    options: { headers?: Record<string, string>; body?: string | ReadableStream<Uint8Array>; signal: AbortSignal },
  ): Promise<Response> {
    assertStorageUrl(url);
    let token: string;
    try {
      token = await this.#tokenProvider();
    } catch {
      fail("credential", "Google access token could not be acquired");
    }
    const init: RequestInit & { duplex?: "half" } = {
      method,
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      signal: options.signal,
    };
    if (options.body !== undefined) {
      init.body = options.body;
      if (typeof options.body !== "string") init.duplex = "half";
    }
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      // Transport failures never propagate the cause: it may echo the authorized request.
      if (error instanceof WorkspaceObjectStoreError) throw error;
      if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
        fail("timeout", `GCS ${method} request exceeded its deadline`);
      }
      fail("unavailable", `GCS ${method} request failed before a response was received`);
    }
  }

  /** Maps a definitive HTTP status to a typed error; the upstream error body is never read. */
  #httpError(response: Response, operation: string): WorkspaceObjectStoreError {
    cancelQuietly(response);
    const status = response.status;
    const code: WorkspaceObjectStoreErrorCode =
      status === 400
        ? "invalid_input"
        : status === 401 || status === 403
          ? "credential"
          : status === 404
            ? "missing"
            : status === 409 || status === 412
              ? "conflict"
              : "unavailable";
    return new WorkspaceObjectStoreError(code, `GCS ${operation} failed with HTTP ${status}`, { status });
  }
}
