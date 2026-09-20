import { AwsClient } from "aws4fetch";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { type SkillObjectStore, SkillObjectStoreError } from "./skill-object-store.js";

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
    const response = await this.#request("PUT", key, {
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
    const response = await this.#request("GET", key, { headers: {} });
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
    const response = await this.#request("HEAD", key, { headers: {} });
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
    const response = await this.#request("DELETE", key, { headers: {} });
    if (response.status === 200 || response.status === 202 || response.status === 204) {
      cancelQuietly(response);
      return;
    }
    cancelQuietly(response);
    throw this.#httpError("DELETE", response);
  }

  /** Builds the object URL from the configured endpoint and the derived key; signs, then sends. */
  async #request(
    method: Method,
    key: string,
    init: { headers: Record<string, string>; body?: Uint8Array },
  ): Promise<Response> {
    const url = this.#objectUrl(key);
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let request: Request;
    try {
      request = await this.#aws.sign(url, { method, headers: init.headers, body: init.body, signal });
    } catch {
      this.#log(method, key, undefined, startedAt);
      throw new SkillObjectStoreError("unavailable", `Skill object store ${method} could not be signed`);
    }
    let response: Response;
    try {
      response = await this.#fetch(request);
    } catch (error) {
      this.#log(method, key, undefined, startedAt);
      const aborted = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
      throw new SkillObjectStoreError(
        "unavailable",
        aborted
          ? `Skill object store ${method} exceeded its deadline`
          : `Skill object store ${method} failed before a response`,
      );
    }
    this.#log(method, key, response.status, startedAt);
    return response;
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
