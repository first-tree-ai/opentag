import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createLogger } from "../../observability/logger.js";
import { ensurePrivateDirectory, syncDurableDirectory } from "../../storage/durable-file.js";
import {
  type ProviderCliAccountLayout,
  providerCliArtifactId,
  providerCliStagingDirPath,
  providerCliVersionDirPath,
} from "./account-layout.js";
import type { ProviderCliCatalogArtifact, ProviderCliCatalogEntry } from "./catalog.js";
import { type ProviderCliExecFile, probeProviderCliExecutable } from "./probe.js";
import { extractProviderCliExecutable, ProviderCliArchiveError } from "./tar.js";
import type { ProviderCliDiagnosticCode, ProviderCliProvider } from "./types.js";

/**
 * Explicit managed-install transaction.
 *
 * One operation: acquire the account/provider lock (held by the caller), download the
 * reviewed catalog artifact into a private staging directory with time and size limits,
 * verify the exact digest, safely extract only the expected executable, publish to a
 * digest-addressed immutable version directory, and run the full non-secret probe.
 * Nothing here runs an upstream installer, escalates privileges, or mutates any prior
 * selection or version directory.
 */

export class ProviderCliInstallError extends Error {
  override readonly name = "ProviderCliInstallError";
  constructor(
    readonly code: Extract<
      ProviderCliDiagnosticCode,
      "integrity_failed" | "install_incomplete" | "probe_failed" | "version_incompatible" | "unsupported_platform"
    >,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Bounded artifact download; the default implementation follows redirects off the reviewed URL.
 * `signal` cancels it (daemon shutdown): the promise then rejects with the signal's reason, never
 * with a ProviderCliInstallError, so cancellation is not reported as a broken artifact.
 */
export type ProviderCliFetcher = (options: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<Uint8Array>;

/** Rethrow the caller's cancellation as itself instead of as a download failure. */
function throwIfCancelled(cancel: AbortSignal | undefined): void {
  if (cancel?.aborted) throw cancel.reason ?? new DOMException("The operation was aborted", "AbortError");
}

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECT_HOPS = 8;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000];
const RETRY_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const logger = createLogger("runtime-provider-cli-installer");

class TransientArtifactError extends Error {}

function isTransientArtifactError(error: unknown): boolean {
  if (error instanceof TransientArtifactError) return true;
  const network = error as { code?: string; cause?: { code?: string } } | undefined;
  return RETRY_NETWORK_CODES.has(network?.cause?.code ?? network?.code ?? "");
}

async function waitForArtifactRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Resolve one request or redirect hop to the next URL. Every hop — the reviewed catalog
 * URL itself and every redirect target — must be HTTPS; a plaintext hop is a downgrade
 * attack on the artifact channel and fails closed as an integrity failure.
 */
export function resolveProviderCliArtifactUrl(current: string, location?: string): string {
  let next: URL;
  try {
    next = location === undefined ? new URL(current) : new URL(location, current);
  } catch (error) {
    logger.debug({ code: "artifact_url_invalid", error: String(error) }, "Provider CLI artifact URL was invalid");
    throw new ProviderCliInstallError("integrity_failed", "Artifact URL or redirect target is not a valid URL");
  }
  if (next.protocol !== "https:") {
    throw new ProviderCliInstallError("integrity_failed", "Artifact URL and every redirect hop must use HTTPS");
  }
  return next.toString();
}

async function cancelProviderCliRedirectBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch (error) {
    logger.debug(
      { code: "redirect_body_cleanup_failed", error: String(error) },
      "Provider CLI redirect body cleanup failed",
    );
    throw new ProviderCliInstallError(
      "install_incomplete",
      `Artifact redirect cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchProviderCliArtifactResponse(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = resolveProviderCliArtifactUrl(url);
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    await cancelProviderCliRedirectBody(response);
    if (location === null) {
      throw new ProviderCliInstallError("integrity_failed", "Artifact redirect has no Location header");
    }
    if (redirects >= MAX_REDIRECT_HOPS) {
      throw new ProviderCliInstallError("install_incomplete", "Artifact download exceeded the redirect bound");
    }
    current = resolveProviderCliArtifactUrl(current, location);
  }
}

function concatenateProviderCliArtifactChunks(chunks: readonly Uint8Array[], received: number): Uint8Array {
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readProviderCliArtifactBody(
  response: Response,
  maxBytes: number,
  cancel: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (!response.ok) {
    await cancelProviderCliRedirectBody(response);
    const message = `Artifact download failed with HTTP ${response.status}`;
    if (RETRY_STATUSES.has(response.status)) throw new TransientArtifactError(message);
    throw new ProviderCliInstallError("install_incomplete", message);
  }
  const length = response.headers.get("content-length");
  if (length !== null && Number.parseInt(length, 10) > maxBytes) {
    await cancelProviderCliRedirectBody(response);
    throw new ProviderCliInstallError("integrity_failed", "Artifact exceeds the reviewed size bound");
  }
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new ProviderCliInstallError("integrity_failed", "Artifact exceeds the reviewed size bound");
    }
    return body;
  }

  const reader = response.body.getReader();
  // The fetch signal already aborts the body; also cancel the reader so a stream that ignores the
  // signal cannot keep the socket (and the daemon process) alive after cancellation.
  const onCancel = () => void reader.cancel(cancel?.reason).catch(() => undefined);
  cancel?.addEventListener("abort", onCancel, { once: true });
  if (cancel?.aborted) onCancel();
  try {
    return await readProviderCliArtifactChunks(reader, maxBytes, cancel);
  } finally {
    cancel?.removeEventListener("abort", onCancel);
    reader.releaseLock();
  }
}

async function readProviderCliArtifactChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  cancel: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    throwIfCancelled(cancel);
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (error) {
      throwIfCancelled(cancel);
      throw error;
    }
    throwIfCancelled(cancel);
    const { done, value } = next;
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ProviderCliInstallError("integrity_failed", "Artifact exceeds the reviewed size bound");
    }
    chunks.push(value);
  }
  return concatenateProviderCliArtifactChunks(chunks, received);
}

async function fetchProviderCliArtifactWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await fetchProviderCliArtifactResponse(fetchImpl, url, signal);
      const body = await readProviderCliArtifactBody(response, maxBytes, signal);
      signal.throwIfAborted();
      return body;
    } catch (error) {
      signal.throwIfAborted();
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientArtifactError(error)) throw error;
      await waitForArtifactRetry(delay, signal);
    }
  }
}

/** Create a bounded GET fetcher; retries, redirects and body reads share one deadline. */
export function createProviderCliFetcher(fetchImpl: typeof fetch = fetch): ProviderCliFetcher {
  return async ({ url, maxBytes, timeoutMs, signal: cancel }) => {
    throwIfCancelled(cancel);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("Artifact download timed out", "TimeoutError")),
      timeoutMs,
    );
    const signal = cancel ? AbortSignal.any([cancel, deadline.signal]) : deadline.signal;
    try {
      return await fetchProviderCliArtifactWithRetry(fetchImpl, url, maxBytes, signal);
    } catch (error) {
      throwIfCancelled(cancel);
      if (error instanceof ProviderCliInstallError) throw error;
      throw new ProviderCliInstallError(
        "install_incomplete",
        `Artifact download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

export const defaultProviderCliFetcher: ProviderCliFetcher = createProviderCliFetcher();

export interface ProviderCliInstallerOptions {
  readonly layout: ProviderCliAccountLayout;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly fetcher?: ProviderCliFetcher;
  readonly execFile?: ProviderCliExecFile;
}

export interface ProviderCliManagedInstall {
  readonly artifactId: string;
  readonly version: string;
  /** Absolute path of the published, probe-verified executable. */
  readonly executablePath: string;
  readonly archiveSha256: string;
  /** True when the digest-addressed version directory already existed. */
  readonly reused: boolean;
}

const STAGING_DIR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ProviderCliInstaller {
  readonly #layout: ProviderCliAccountLayout;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #fetcher: ProviderCliFetcher;
  readonly #execFile: ProviderCliExecFile | undefined;

  constructor(options: ProviderCliInstallerOptions) {
    this.#layout = options.layout;
    this.#platform = options.platform;
    this.#arch = options.arch;
    this.#fetcher = options.fetcher ?? defaultProviderCliFetcher;
    this.#execFile = options.execFile;
  }

  /**
   * Remove recognized stale staging directories from interrupted operations. Safe to
   * run only while holding the provider lock: any staging directory present then is a
   * crash leftover by definition.
   */
  async recoverStaging(provider: ProviderCliProvider): Promise<void> {
    const providerStaging = join(this.#layout.staging, provider);
    const entries = await readdir(providerStaging).catch((error: unknown) => {
      logger.debug({ code: "staging_scan_failed", error: String(error) }, "Provider CLI staging scan failed");
      return [] as string[];
    });
    for (const entry of entries) {
      if (!STAGING_DIR_PATTERN.test(entry)) continue;
      await rm(join(providerStaging, entry), { force: true, recursive: true });
    }
  }

  /**
   * Publish the reviewed catalog artifact for this platform. Callers must hold the
   * account/provider lock. On any failure before publication, no version directory is
   * created or modified. `signal` cancels the operation up to the publishing rename; the
   * staging directory is removed either way and the cancellation reason is rethrown.
   */
  async install(
    entry: ProviderCliCatalogEntry,
    provider: ProviderCliProvider,
    signal?: AbortSignal,
  ): Promise<ProviderCliManagedInstall> {
    throwIfCancelled(signal);
    const artifact = entry.artifacts.find(
      (candidate) => candidate.platform === this.#platform && candidate.arch === this.#arch,
    );
    if (!artifact) {
      throw new ProviderCliInstallError(
        "unsupported_platform",
        `The reviewed catalog has no ${entry.displayName} artifact for ${this.#platform}/${this.#arch}`,
      );
    }
    const artifactId = providerCliArtifactId(artifact, entry.version);
    const versionDir = providerCliVersionDirPath(this.#layout, provider, artifactId);
    const executablePath = join(versionDir, artifact.executablePath);

    // Digest-addressed publication is idempotent: reuse a complete directory, but never
    // overwrite one whose content disagrees with the catalog.
    const existing = await lstat(executablePath).catch((error: unknown) => {
      logger.debug(
        { code: "published_artifact_stat_failed", error: String(error) },
        "Provider CLI published artifact stat failed",
      );
      return undefined;
    });
    if (existing) {
      await verifyPublishedExecutable(executablePath, artifact, entry, this.#execFile);
      return { artifactId, version: entry.version, executablePath, archiveSha256: artifact.sha256, reused: true };
    }

    await this.recoverStaging(provider);
    const installStartedAt = performance.now();
    const operationId = randomUUID();
    const stagingDir = providerCliStagingDirPath(this.#layout, provider, operationId);
    try {
      await ensurePrivateDirectory(this.#layout.root, stagingDir);
      const downloadStartedAt = performance.now();
      const archive = await this.#fetcher({
        url: artifact.url,
        maxBytes: artifact.archiveBytes,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      throwIfCancelled(signal);
      const downloadDurationMs = Math.max(0, Math.round(performance.now() - downloadStartedAt));
      if (archive.byteLength !== artifact.archiveBytes) {
        throw new ProviderCliInstallError("integrity_failed", "Artifact size disagrees with the reviewed catalog");
      }
      const archiveDigest = createHash("sha256").update(archive).digest("hex");
      if (archiveDigest !== artifact.sha256) {
        throw new ProviderCliInstallError("integrity_failed", "Artifact digest disagrees with the reviewed catalog");
      }

      const extractStartedAt = performance.now();
      const extracted = await extractSafely(archive, artifact);
      const extractDurationMs = Math.max(0, Math.round(performance.now() - extractStartedAt));
      const executableDigest = createHash("sha256").update(extracted.content).digest("hex");
      if (executableDigest !== artifact.executableSha256 || extracted.content.byteLength !== artifact.executableBytes) {
        throw new ProviderCliInstallError(
          "integrity_failed",
          "Extracted executable disagrees with the reviewed catalog",
        );
      }

      // Stage the payload, publish with one rename, then make it immutable in place
      // (macOS refuses to rename a directory that is already read-only).
      const payloadDir = join(stagingDir, "payload");
      const payloadExecutable = join(payloadDir, artifact.executablePath);
      await mkdir(dirname(payloadExecutable), { recursive: true, mode: 0o755 });
      await writeStagedExecutable(payloadExecutable, extracted.content);
      await syncDurableDirectory(dirname(payloadExecutable));
      if (dirname(payloadExecutable) !== payloadDir) await syncDurableDirectory(payloadDir);
      // Last cancellation point: after the rename the publication completes as one unit.
      throwIfCancelled(signal);
      await ensurePrivateDirectory(this.#layout.root, dirname(versionDir));
      try {
        await rename(payloadDir, versionDir);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          // A concurrent complete publish is only acceptable when content matches.
          await verifyPublishedExecutable(executablePath, artifact, entry, this.#execFile);
        } else {
          throw error;
        }
      }
      await makeReadOnlyTree(versionDir);
      await syncDurableDirectory(dirname(versionDir));

      // Probe every published or reused artifact. A prior failed publication must never
      // become selectable merely because its digest-addressed directory now exists.
      const probeStartedAt = performance.now();
      await verifyPublishedExecutable(executablePath, artifact, entry, this.#execFile);
      const probeDurationMs = Math.max(0, Math.round(performance.now() - probeStartedAt));
      logger.info(
        {
          provider,
          version: entry.version,
          archiveBytes: artifact.archiveBytes,
          downloadDurationMs,
          extractDurationMs,
          probeDurationMs,
          durationMs: Math.max(0, Math.round(performance.now() - installStartedAt)),
        },
        "Provider CLI artifact installed",
      );
      return { artifactId, version: entry.version, executablePath, archiveSha256: artifact.sha256, reused: false };
    } finally {
      await rm(stagingDir, { force: true, recursive: true }).catch((error: unknown) => {
        logger.debug({ code: "staging_cleanup_failed", error: String(error) }, "Provider CLI staging cleanup failed");
      });
      await rmdir(dirname(stagingDir)).catch((error: unknown) => {
        logger.debug(
          { code: "staging_parent_cleanup_failed", error: String(error) },
          "Provider CLI staging parent cleanup failed",
        );
      });
    }
  }
}

async function extractSafely(archive: Uint8Array, artifact: ProviderCliCatalogArtifact) {
  try {
    return extractProviderCliExecutable(archive, {
      expectedExecutable: artifact.executablePath,
      maxExtractedBytes: artifact.maxExtractedBytes,
      maxExecutableBytes: artifact.executableBytes,
    });
  } catch (error) {
    logger.debug({ code: "archive_extraction_failed", error: String(error) }, "Provider CLI archive extraction failed");
    if (error instanceof ProviderCliArchiveError) {
      throw new ProviderCliInstallError("integrity_failed", `Artifact archive is unsafe: ${error.rejection}`);
    }
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

async function writeStagedExecutable(path: string, content: Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o700,
  );
  try {
    await handle.writeFile(content);
    await handle.chmod(0o755);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyPublishedExecutable(
  path: string,
  artifact: ProviderCliCatalogArtifact,
  entry: ProviderCliCatalogEntry,
  execFile: ProviderCliExecFile | undefined,
): Promise<void> {
  const status = await lstat(path).catch((error: unknown) => {
    logger.debug(
      { code: "artifact_stat_failed", error: String(error) },
      "Provider CLI published artifact stat failed during verification",
    );
    return undefined;
  });
  if (!status?.isFile() || status.isSymbolicLink() || (status.mode & 0o111) === 0) {
    throw new ProviderCliInstallError("integrity_failed", "The immutable version executable is missing or unsafe");
  }
  if (status.size !== artifact.executableBytes || (await hashFile(path)) !== artifact.executableSha256) {
    throw new ProviderCliInstallError(
      "integrity_failed",
      "An immutable version directory disagrees with the reviewed catalog digest",
    );
  }
  const probed = await probeProviderCliExecutable(path, entry, {
    ...(execFile ? { execFile } : {}),
  });
  if (probed.status === "failed") {
    throw new ProviderCliInstallError(
      probed.code === "version_incompatible" ? "version_incompatible" : "probe_failed",
      `The published ${entry.displayName} artifact failed its local compatibility probe`,
    );
  }
}

async function makeReadOnlyTree(path: string): Promise<void> {
  const status = await stat(path);
  if (status.isDirectory()) {
    for (const entry of await readdir(path)) {
      await makeReadOnlyTree(join(path, entry));
    }
  }
  await chmod(path, 0o555);
}
