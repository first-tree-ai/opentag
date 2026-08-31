import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Bounded artifact download; the default implementation follows redirects off the reviewed URL. */
export type ProviderCliFetcher = (options: { url: string; maxBytes: number; timeoutMs: number }) => Promise<Uint8Array>;

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECT_HOPS = 8;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve one request or redirect hop to the next URL. Every hop — the reviewed catalog
 * URL itself and every redirect target — must be HTTPS; a plaintext hop is a downgrade
 * attack on the artifact channel and fails closed as an integrity failure.
 */
export function resolveProviderCliArtifactUrl(current: string, location?: string): string {
  let next: URL;
  try {
    next = location === undefined ? new URL(current) : new URL(location, current);
  } catch {
    throw new ProviderCliInstallError("integrity_failed", "Artifact URL or redirect target is not a valid URL");
  }
  if (next.protocol !== "https:") {
    throw new ProviderCliInstallError("integrity_failed", "Artifact URL and every redirect hop must use HTTPS");
  }
  return next.toString();
}

/**
 * Create the bounded artifact fetcher. `fetchImpl` exists so tests can exercise the
 * full redirect and size-bound policy without network or TLS; production always uses
 * the global fetch with manual redirect handling.
 */
export function createProviderCliFetcher(fetchImpl: typeof fetch = fetch): ProviderCliFetcher {
  return async ({ url, maxBytes, timeoutMs }) => {
    let current = resolveProviderCliArtifactUrl(url);
    let response: Response | undefined;
    for (let hops = 0; ; hops += 1) {
      try {
        response = await fetchImpl(current, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ProviderCliInstallError(
          "install_incomplete",
          `Artifact download failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (response.body) {
          try {
            await response.body.cancel();
          } catch (error) {
            throw new ProviderCliInstallError(
              "install_incomplete",
              `Artifact redirect cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (location === null) {
          throw new ProviderCliInstallError("integrity_failed", "Artifact redirect has no Location header");
        }
        if (hops + 1 >= MAX_REDIRECT_HOPS) {
          throw new ProviderCliInstallError("install_incomplete", "Artifact download exceeded the redirect bound");
        }
        current = resolveProviderCliArtifactUrl(current, location);
        continue;
      }
      break;
    }
    if (!response.ok) {
      throw new ProviderCliInstallError("install_incomplete", `Artifact download failed with HTTP ${response.status}`);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number.parseInt(length, 10) > maxBytes) {
      throw new ProviderCliInstallError("integrity_failed", "Artifact exceeds the reviewed size bound");
    }
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new ProviderCliInstallError("integrity_failed", "Artifact exceeds the reviewed size bound");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
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
    const entries = await readdir(providerStaging).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!STAGING_DIR_PATTERN.test(entry)) continue;
      await rm(join(providerStaging, entry), { force: true, recursive: true });
    }
  }

  /**
   * Publish the reviewed catalog artifact for this platform. Callers must hold the
   * account/provider lock. On any failure before publication, no version directory is
   * created or modified.
   */
  async install(entry: ProviderCliCatalogEntry, provider: ProviderCliProvider): Promise<ProviderCliManagedInstall> {
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
    const existing = await lstat(executablePath).catch(() => undefined);
    if (existing) {
      await verifyPublishedExecutable(executablePath, artifact, entry, this.#execFile);
      return { artifactId, version: entry.version, executablePath, archiveSha256: artifact.sha256, reused: true };
    }

    await this.recoverStaging(provider);
    const operationId = randomUUID();
    const stagingDir = providerCliStagingDirPath(this.#layout, provider, operationId);
    try {
      await ensurePrivateDirectory(this.#layout.root, stagingDir);
      const archive = await this.#fetcher({
        url: artifact.url,
        maxBytes: artifact.archiveBytes,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (archive.byteLength !== artifact.archiveBytes) {
        throw new ProviderCliInstallError("integrity_failed", "Artifact size disagrees with the reviewed catalog");
      }
      const archiveDigest = createHash("sha256").update(archive).digest("hex");
      if (archiveDigest !== artifact.sha256) {
        throw new ProviderCliInstallError("integrity_failed", "Artifact digest disagrees with the reviewed catalog");
      }

      const extracted = await extractSafely(archive, artifact);
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
      await verifyPublishedExecutable(executablePath, artifact, entry, this.#execFile);
      return { artifactId, version: entry.version, executablePath, archiveSha256: artifact.sha256, reused: false };
    } finally {
      await rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
      await rmdir(dirname(stagingDir)).catch(() => undefined);
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
  const status = await lstat(path).catch(() => undefined);
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
