import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createLogger } from "../../observability/logger.js";

/**
 * Content-addressed identity of one executable file. `path` is the canonical realpath;
 * `sha256` covers the full file content, so any post-validation replacement is visible.
 */
export interface ProviderCliFileIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** Hard bound for any selected Provider CLI executable, including external wrappers. */
export const MAX_PROVIDER_CLI_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const logger = createLogger("runtime-provider-cli-fingerprint");

export class ProviderCliFileError extends Error {
  override readonly name = "ProviderCliFileError";
  constructor(
    readonly code: "missing" | "not-regular-file" | "too-large" | "changed",
    path: string,
  ) {
    super(`Provider CLI executable identity failed (${code}): ${path}`);
  }
}

export async function computeFileIdentity(
  path: string,
  maxBytes: number = MAX_PROVIDER_CLI_EXECUTABLE_BYTES,
): Promise<ProviderCliFileIdentity> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    logger.debug({ code: "file_realpath_failed", error: String(error) }, "Provider CLI file canonicalization failed");
    throw new ProviderCliFileError("missing", path);
  }
  const status = await stat(canonical);
  if (!status.isFile()) throw new ProviderCliFileError("not-regular-file", canonical);
  if (status.size > maxBytes) throw new ProviderCliFileError("too-large", canonical);
  const hash = createHash("sha256");
  let bytesRead = 0;
  for await (const chunk of createReadStream(canonical)) {
    const bytes = chunk as Uint8Array;
    bytesRead += bytes.byteLength;
    if (bytesRead > maxBytes) throw new ProviderCliFileError("too-large", canonical);
    hash.update(bytes);
  }
  if (bytesRead !== status.size) throw new ProviderCliFileError("changed", canonical);
  return { path: canonical, size: status.size, sha256: hash.digest("hex") };
}

/**
 * Deterministic fingerprint over the parts that define executable identity for
 * OpenTag: canonical target, file identity, version, and the managed archive digest
 * when the target is a managed artifact.
 */
export function computeTargetFingerprint(
  identity: ProviderCliFileIdentity,
  version: string,
  managedDigest?: string,
): string {
  const hash = createHash("sha256");
  const parts = [identity.path, String(identity.size), identity.sha256, version, managedDigest ?? ""];
  // Encode tuple boundaries explicitly; concatenation can represent distinct tuples
  // with the same byte sequence.
  hash.update(JSON.stringify(parts));
  return `v1:${hash.digest("hex")}`;
}
