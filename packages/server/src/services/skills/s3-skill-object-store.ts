import { AwsClient } from "aws4fetch";
import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  type SkillObjectListEntry,
  type SkillObjectListOptions,
  type SkillObjectListResult,
  type SkillObjectStore,
  SkillObjectStoreError,
} from "./skill-object-store.js";

/**
 * S3-compatible `SkillObjectStore` on `aws4fetch` — SigV4 over `fetch` with zero transitive
 * dependencies and no default checksum behaviour, which several S3-compatible services reject.
 *
 * The adapter derives every URL from the configured endpoint plus the server-derived key; a caller
 * never supplies an origin, a bucket, or a path. `forcePathStyle` selects `<endpoint>/<bucket>/<key>`
 * for services that cannot serve virtual-hosted buckets. Every request carries a real
 * `x-amz-content-sha256` (never `UNSIGNED-PAYLOAD`), a per-request deadline, and a status-to-code
 * mapping: 404 → `not_found`, 5xx or a transport failure → `unavailable`, any other 4xx →
 * `rejected`. Debug logs carry the key, status, and duration only — never the access key or secret.
 */

export interface S3SkillObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface S3SkillObjectStoreOptions {
  config: S3SkillObjectStoreConfig;
  /** Injectable transport; production uses the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  logger?: ServiceLogger;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 1000;
const MAX_LIST_BODY_CHARS = 4 * 1024 * 1024;

type Method = "PUT" | "GET" | "HEAD" | "DELETE";

function cancelQuietly(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function encodedKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveListLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new SkillObjectStoreError("rejected", "Skill object store LIST limit is not a bounded positive integer");
  }
  return limit;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tagValue(block: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1];
}

/**
 * A bounded `ListObjectsV2` extractor: it reads only the fields the GC needs and never treats the
 * document as trusted. Anything it cannot represent faithfully — an incomplete entry, a bad date or
 * size, a truncated page without a continuation token — is `invalid_response` rather than a guess.
 */
function parseSkillObjectList(xml: string, limit: number): SkillObjectListResult {
  if (xml.length > MAX_LIST_BODY_CHARS) {
    throw new SkillObjectStoreError("invalid_response", "Skill object store LIST body is implausibly large");
  }
  const objects: SkillObjectListEntry[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    if (objects.length >= limit) break;
    const block = match[1] as string;
    const rawKey = tagValue(block, "Key");
    const rawLastModified = tagValue(block, "LastModified");
    const rawSize = tagValue(block, "Size");
    if (rawKey === undefined || rawLastModified === undefined || rawSize === undefined) {
      throw new SkillObjectStoreError("invalid_response", "Skill object store LIST entry is incomplete");
    }
    const lastModified = new Date(unescapeXml(rawLastModified));
    const bytes = Number(rawSize);
    if (Number.isNaN(lastModified.getTime()) || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new SkillObjectStoreError("invalid_response", "Skill object store LIST entry is malformed");
    }
    objects.push({ key: unescapeXml(rawKey), lastModified, bytes });
  }
  const truncated = (tagValue(xml, "IsTruncated") ?? "false").trim().toLowerCase() === "true";
  if (!truncated) return { objects };
  const token = tagValue(xml, "NextContinuationToken");
  if (token === undefined || token.length === 0) {
    throw new SkillObjectStoreError("invalid_response", "Skill object store LIST is truncated without a token");
  }
  return { objects, nextCursor: unescapeXml(token) };
}

export class S3SkillObjectStore implements SkillObjectStore {
  readonly #config: S3SkillObjectStoreConfig;
  readonly #aws: AwsClient;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #logger?: ServiceLogger;
  readonly #base: URL;

  constructor(options: S3SkillObjectStoreOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new SkillObjectStoreError("rejected", "Skill storage timeout must be a positive bounded integer");
    }
    let base: URL;
    try {
      base = new URL(options.config.endpoint);
    } catch {
      throw new SkillObjectStoreError("rejected", "Skill storage endpoint is not a URL");
    }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new SkillObjectStoreError(
        "rejected",
        "Skill storage endpoint must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    if (options.config.bucket.length === 0) {
      throw new SkillObjectStoreError("rejected", "Skill storage bucket is empty");
    }
    this.#config = options.config;
    this.#base = base;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeoutMs;
    if (options.logger) this.#logger = options.logger;
    this.#aws = new AwsClient({
      accessKeyId: options.config.accessKeyId,
      secretAccessKey: options.config.secretAccessKey,
      region: options.config.region,
      service: "s3",
      // The service maps failures explicitly; internal retries would multiply the request deadline.
      retries: 0,
    });
  }

  async put(key: string, body: Uint8Array, meta: { sha256: string }): Promise<void> {
    const response = await this.#request("PUT", this.#objectUrl(key), key, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(body.byteLength),
        "x-amz-content-sha256": meta.sha256,
      },
      body,
    });
    if (response.status === 200 || response.status === 201 || response.status === 204) {
      cancelQuietly(response);
      return;
    }
    cancelQuietly(response);
    throw this.#httpError("PUT", response);
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#request("GET", this.#objectUrl(key), key, { headers: {} });
    if (!response.ok) {
      cancelQuietly(response);
      throw this.#httpError("GET", response);
    }
    if (!response.body) {
      throw new SkillObjectStoreError("invalid_response", "Skill object store GET returned no body");
    }
    return response.body;
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    const response = await this.#request("HEAD", this.#objectUrl(key), key, { headers: {} });
    cancelQuietly(response);
    if (response.status === 404) return null;
    if (!response.ok) throw this.#httpError("HEAD", response);
    const raw = response.headers.get("content-length");
    const bytes = raw === null ? Number.NaN : Number(raw);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new SkillObjectStoreError("invalid_response", "Skill object store HEAD reported no valid length");
    }
    return { bytes };
  }

  async delete(key: string): Promise<void> {
    const response = await this.#request("DELETE", this.#objectUrl(key), key, { headers: {} });
    if (response.status === 200 || response.status === 202 || response.status === 204) {
      cancelQuietly(response);
      return;
    }
    cancelQuietly(response);
    throw this.#httpError("DELETE", response);
  }

  async list(prefix: string, options: SkillObjectListOptions = {}): Promise<SkillObjectListResult> {
    const limit = resolveListLimit(options.limit);
    const response = await this.#request("GET", this.#listUrl(prefix, limit, options.cursor), prefix, {
      headers: {},
    });
    if (!response.ok) {
      cancelQuietly(response);
      throw this.#httpError("GET", response);
    }
    let xml: string;
    try {
      xml = await response.text();
    } catch {
      throw new SkillObjectStoreError("invalid_response", "Skill object store LIST body could not be read");
    }
    return parseSkillObjectList(xml, limit);
  }

  /** Builds the object URL from the configured endpoint and the derived key; signs, then sends. */
  async #request(
    method: Method,
    url: string,
    logKey: string,
    init: { headers: Record<string, string>; body?: Uint8Array },
  ): Promise<Response> {
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let request: Request;
    try {
      request = await this.#aws.sign(url, { method, headers: init.headers, body: init.body, signal });
    } catch {
      this.#log(method, logKey, undefined, startedAt);
      throw new SkillObjectStoreError("unavailable", `Skill object store ${method} could not be signed`);
    }
    let response: Response;
    try {
      response = await this.#fetch(request);
    } catch (error) {
      this.#log(method, logKey, undefined, startedAt);
      const aborted = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
      throw new SkillObjectStoreError(
        "unavailable",
        aborted
          ? `Skill object store ${method} exceeded its deadline`
          : `Skill object store ${method} failed before a response`,
      );
    }
    this.#log(method, logKey, response.status, startedAt);
    return response;
  }

  /** The bucket-list URL: path style addresses the bucket, virtual-hosted puts it in the hostname. */
  #listUrl(prefix: string, limit: number, cursor?: string): string {
    const url = new URL(this.#base.toString());
    const basePath = url.pathname.replace(/\/+$/, "");
    if (this.#config.forcePathStyle) {
      url.pathname = `${basePath}/${this.#config.bucket}/`;
    } else {
      url.hostname = `${this.#config.bucket}.${url.hostname}`;
      url.pathname = `${basePath}/`;
    }
    url.searchParams.set("list-type", "2");
    if (prefix.length > 0) url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", String(limit));
    if (cursor !== undefined && cursor.length > 0) url.searchParams.set("continuation-token", cursor);
    return url.toString();
  }

  #objectUrl(key: string): string {
    const url = new URL(this.#base.toString());
    const prefix = url.pathname.replace(/\/+$/, "");
    if (this.#config.forcePathStyle) {
      url.pathname = `${prefix}/${this.#config.bucket}/${encodedKeyPath(key)}`;
    } else {
      url.hostname = `${this.#config.bucket}.${url.hostname}`;
      url.pathname = `${prefix}/${encodedKeyPath(key)}`;
    }
    return url.toString();
  }

  #httpError(method: Method, response: Response): SkillObjectStoreError {
    const status = response.status;
    const code: SkillObjectStoreError["code"] =
      status === 404 ? "not_found" : status >= 500 ? "unavailable" : "rejected";
    return new SkillObjectStoreError(code, `Skill object store ${method} failed with HTTP ${status}`, { status });
  }

  /** Key, status, and duration only; the access key and secret never reach a log line. */
  #log(method: Method, key: string, status: number | undefined, startedAt: number): void {
    this.#logger?.debug({ key, method, status, durationMs: Date.now() - startedAt }, "Skill object store request");
  }
}
