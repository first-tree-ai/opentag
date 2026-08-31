import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";
import semver from "semver";
import { protectedRoots, resolveOutsideProtectedRoots } from "../protected-paths.js";
import {
  type ProviderCliAccountLayout,
  providerCliLauncherPath,
  resolveProviderCliAccountLayout,
} from "./account-layout.js";
import { catalogExecutableDigests, type ProviderCliCatalogEntry } from "./catalog.js";
import { executableFormatSupportsHost, inspectExecutableFormat } from "./executable-format.js";
import { computeFileIdentity, computeTargetFingerprint, type ProviderCliFileIdentity } from "./fingerprint.js";
import { defaultProviderCliExecFile, type ProviderCliExecFile, probeProviderCliExecutable } from "./probe.js";
import type { ProviderCliSelectionRecord } from "./selection-store.js";
import type { ProviderCliProvider, ProviderCliTrust } from "./types.js";

/**
 * User-facing external detection: one bounded, read-only scan of exact provider command
 * names in the invoking CLI process's PATH. It never scans version managers or home
 * trees, never starts a login shell, and never touches credentials or provider APIs.
 */

export interface ProviderCliCandidate {
  /** Ephemeral identity valid only for this detection pass. */
  readonly id: string;
  readonly provider: ProviderCliProvider;
  readonly kind: "external" | "managed";
  /** Canonical realpath of the exact executable this candidate would run. */
  readonly path: string;
  /** PATH directory that contributed the candidate, or `selection`. */
  readonly sourceDir: string;
  readonly version: string;
  readonly trust: ProviderCliTrust;
  readonly fingerprint: string;
  /** Managed archive digest when the candidate is a managed artifact. */
  readonly managedDigest?: string;
  /** Effective PATH order index; candidates not on PATH sort last. */
  readonly pathRank: number;
  /** True when the candidate is the current persisted selection. */
  readonly incumbent: boolean;
}

export interface IgnoredProviderCliCandidate {
  readonly path: string;
  readonly sourceDir?: string;
  readonly version?: string;
  readonly reason: string;
}

export interface ProviderCliDetection {
  readonly candidates: readonly ProviderCliCandidate[];
  readonly ignored: readonly IgnoredProviderCliCandidate[];
}

export interface ProviderCliDetectOptions {
  readonly provider: ProviderCliProvider;
  readonly entry: ProviderCliCatalogEntry;
  readonly layout: ProviderCliAccountLayout;
  /** Invoking CLI process environment; the only PATH authority for detection. */
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly selection: ProviderCliSelectionRecord | undefined;
  readonly mode: "auto" | "managed-only";
  readonly execFile?: ProviderCliExecFile;
}

const PATH_ENTRY_LIMIT = 256;
const CANDIDATE_PROBE_LIMIT = 16;
const EXECUTABLE_HEADER_BYTES = 64;

async function canonicalSafeDirectory(
  entry: string,
  platform: NodeJS.Platform,
  accountHome: string,
): Promise<{ dir: string } | { reason: string }> {
  if (entry.length === 0) return { reason: "empty-path-entry" };
  if (!isAbsolute(entry)) return { reason: "relative-path-entry" };
  const protectedRootList = protectedRoots(platform, accountHome);
  const canonical = resolveOutsideProtectedRoots(entry, protectedRootList);
  if (canonical === null) return { reason: "protected-path-entry" };
  const status = await lstat(canonical).catch(() => undefined);
  if (!status) return { reason: "unreadable-path-entry" };
  if (!status.isDirectory() || status.isSymbolicLink()) return { reason: "non-directory-path-entry" };
  if ((status.mode & 0o002) !== 0) return { reason: "world-writable-path-entry" };
  return { dir: canonical };
}

async function readExecutableHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(EXECUTABLE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, EXECUTABLE_HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface AssessedCandidate {
  readonly version: string;
  readonly trust: ProviderCliTrust;
  readonly fingerprint: string;
  readonly identity: ProviderCliFileIdentity;
}

/**
 * Validate one canonical executable path: regular file, executable, not world-writable,
 * right platform/architecture, version parse and compatibility, required command
 * surface, then content identity and trust.
 */
async function assessCandidatePath(
  canonical: string,
  options: ProviderCliDetectOptions,
  execFile: ProviderCliExecFile,
  digests: ReadonlySet<string>,
  managedDigest?: string,
): Promise<AssessedCandidate | { reason: string; version?: string }> {
  const status = await lstat(canonical).catch(() => undefined);
  if (!status) return { reason: "not-found" };
  if (!status.isFile() || status.isSymbolicLink()) return { reason: "not-regular-file" };
  if ((status.mode & 0o111) === 0) return { reason: "not-executable" };
  if ((status.mode & 0o002) !== 0) return { reason: "world-writable" };

  const header = await readExecutableHeader(canonical).catch(() => undefined);
  if (!header) return { reason: "unreadable" };
  const format = inspectExecutableFormat(header);
  if (format.kind === "unknown") return { reason: "unrecognized-format" };
  if (!executableFormatSupportsHost(format, options.platform, options.arch)) {
    return { reason: "wrong-platform-architecture" };
  }

  const identity = await computeFileIdentity(canonical).catch(() => undefined);
  if (!identity) return { reason: "not-found" };
  const probed = await probeProviderCliExecutable(canonical, options.entry, {
    execFile,
  });
  if (probed.status === "failed") {
    return {
      reason:
        probed.code === "unparseable_version"
          ? "unparseable-version"
          : probed.code === "version_incompatible"
            ? "version-incompatible"
            : "probe-failed",
    };
  }
  const trust: ProviderCliTrust =
    managedDigest !== undefined || digests.has(identity.sha256) ? "catalog-verified" : "compatible-unverified";
  return {
    version: probed.version,
    trust,
    fingerprint: computeTargetFingerprint(identity, probed.version, managedDigest),
    identity,
  };
}

function managedDigestOf(selection: ProviderCliSelectionRecord): string | undefined {
  if (selection.selection.kind !== "managed") return undefined;
  const digest = selection.selection.artifactId.split("/").at(-1);
  return digest && digest.length > 0 ? digest : undefined;
}

export async function detectProviderCliCandidates(options: ProviderCliDetectOptions): Promise<ProviderCliDetection> {
  const execFile = options.execFile ?? defaultProviderCliExecFile;
  const digests = catalogExecutableDigests(options.entry);
  const candidates: ProviderCliCandidate[] = [];
  const ignored: IgnoredProviderCliCandidate[] = [];
  const seenCanonical = new Set<string>();
  const pathRanks = new Map<string, number>();
  let sequence = 0;
  let probedCandidateCount = 0;

  const launcherPath = providerCliLauncherPath(options.layout, options.entry.command);
  const launcherCanonical = await realpath(launcherPath).catch(() => undefined);
  // PATH candidates are canonicalized by realpath; the account root and protected
  // roots must be canonical too, or symlinked prefixes (e.g. /var on macOS) never match.
  const accountHome = await realpath(options.layout.accountHome).catch(() => options.layout.accountHome);
  const layoutRoot = await realpath(options.layout.root).catch(
    () => resolveProviderCliAccountLayout(accountHome, options.platform).root,
  );

  // --- PATH scan (skipped entirely in managed-only mode). ---
  if (options.mode === "auto") {
    const pathEntries = (options.env.PATH ?? "").split(delimiter).slice(0, PATH_ENTRY_LIMIT);
    let rank = 0;
    for (const rawEntry of pathEntries) {
      const currentRank = rank;
      rank += 1;
      if (rawEntry.length === 0) continue; // An empty entry means the current directory: never used.
      const directory = await canonicalSafeDirectory(rawEntry, options.platform, accountHome);
      if ("reason" in directory) {
        // Nonexistent directories are common PATH leftovers; only unsafe entries are reported.
        if (directory.reason !== "unreadable-path-entry") {
          ignored.push({ path: rawEntry, reason: directory.reason });
        }
        continue;
      }
      const candidatePath = join(directory.dir, options.entry.command);
      let canonical: string;
      try {
        await access(candidatePath, constants.X_OK);
        canonical = await realpath(candidatePath);
      } catch {
        continue; // A directory without this command contributes nothing.
      }
      if (seenCanonical.has(canonical)) {
        pathRanks.set(canonical, Math.min(pathRanks.get(canonical) ?? currentRank, currentRank));
        continue;
      }
      seenCanonical.add(canonical);
      pathRanks.set(canonical, currentRank);

      // The account-global launcher and anything inside the OpenTag-managed root are
      // classified as managed and never offered again as external candidates.
      if (canonical === launcherCanonical || canonical.startsWith(`${layoutRoot}${sep}`)) {
        continue;
      }

      if (probedCandidateCount >= CANDIDATE_PROBE_LIMIT) {
        ignored.push({ path: rawEntry, reason: "candidate-probe-limit-reached" });
        break;
      }
      probedCandidateCount += 1;

      const assessed = await assessCandidatePath(canonical, options, execFile, digests);
      if ("reason" in assessed) {
        ignored.push({ path: canonical, sourceDir: directory.dir, ...assessed });
        continue;
      }
      sequence += 1;
      candidates.push({
        id: `candidate-${sequence}`,
        provider: options.provider,
        kind: "external",
        path: canonical,
        sourceDir: directory.dir,
        version: assessed.version,
        trust: assessed.trust,
        fingerprint: assessed.fingerprint,
        pathRank: currentRank,
        incumbent: false,
      });
    }
  }

  // --- The current selection is always part of the candidate set. ---
  const selection = options.selection;
  if (selection) {
    const targetPath =
      selection.selection.kind === "managed" ? selection.selection.targetPath : selection.selection.executablePath;
    const managedDigest = managedDigestOf(selection);
    const incumbent = await assessCandidatePath(targetPath, options, execFile, digests, managedDigest);
    if ("reason" in incumbent) {
      const reason =
        selection.selection.kind === "external" &&
        (incumbent.reason === "not-found" || incumbent.reason === "not-regular-file")
          ? "external-path-invalid"
          : incumbent.reason;
      ignored.push({ path: targetPath, sourceDir: "selection", reason });
    } else {
      const incumbentPath = incumbent.identity.path;
      const merged: ProviderCliCandidate = {
        id: "candidate-selection",
        provider: options.provider,
        kind: selection.selection.kind,
        path: incumbentPath,
        sourceDir: candidates.find((candidate) => candidate.path === incumbentPath)?.sourceDir ?? "selection",
        version: incumbent.version,
        trust: selection.selection.kind === "managed" ? "catalog-verified" : incumbent.trust,
        fingerprint: incumbent.fingerprint,
        ...(managedDigest ? { managedDigest } : {}),
        pathRank: pathRanks.get(incumbentPath) ?? Number.MAX_SAFE_INTEGER,
        incumbent: true,
      };
      if (options.mode === "managed-only" && merged.kind === "external") {
        ignored.push({ path: incumbentPath, sourceDir: "selection", reason: "managed-only" });
      } else {
        const existing = candidates.findIndex((candidate) => candidate.path === incumbentPath);
        if (existing >= 0) candidates.splice(existing, 1, merged);
        else candidates.push(merged);
      }
    }
  }

  return { candidates, ignored };
}

/**
 * Deterministic candidate ranking: newest compatible version first, then
 * catalog-verified trust, then the incumbent selection, then effective PATH order.
 * Also explains the winner and each loser for reporting.
 */
export function rankProviderCliCandidates(candidates: readonly ProviderCliCandidate[]): {
  readonly ordered: readonly ProviderCliCandidate[];
  readonly reasons: ReadonlyMap<string, string>;
} {
  const ordered = [...candidates].sort((left, right) => {
    const byVersion = semver.rcompare(left.version, right.version);
    if (byVersion !== 0) return byVersion;
    const trustRank = (trust: ProviderCliTrust): number => (trust === "catalog-verified" ? 0 : 1);
    const byTrust = trustRank(left.trust) - trustRank(right.trust);
    if (byTrust !== 0) return byTrust;
    const byIncumbent = Number(right.incumbent) - Number(left.incumbent);
    if (byIncumbent !== 0) return byIncumbent;
    const byPath = left.pathRank - right.pathRank;
    if (byPath !== 0) return byPath;
    return left.path.localeCompare(right.path);
  });
  const reasons = new Map<string, string>();
  const winner = ordered[0];
  if (winner) {
    const runnerUp = ordered[1];
    let reason = "newest compatible version";
    if (runnerUp && semver.compare(winner.version, runnerUp.version) === 0) {
      if (winner.trust !== runnerUp.trust) reason = "catalog-verified trust";
      else if (winner.incumbent && !runnerUp.incumbent) reason = "current selection";
      else reason = "first in PATH";
    }
    reasons.set(winner.id, reason);
    for (const loser of ordered.slice(1)) {
      if (semver.compare(winner.version, loser.version) !== 0) {
        reasons.set(loser.id, "older compatible version");
      } else if (winner.trust !== loser.trust) {
        reasons.set(loser.id, "same version with lower trust");
      } else if (loser.incumbent !== winner.incumbent) {
        reasons.set(loser.id, "same version, not the current selection");
      } else {
        reasons.set(loser.id, "same version, later in PATH");
      }
    }
  }
  return { ordered, reasons };
}

/**
 * Reopen a winner by canonical path and recompute its fingerprint immediately before
 * persistence. A changed candidate is rejected so the caller can rank again.
 */
export async function verifyProviderCliCandidateFingerprint(candidate: ProviderCliCandidate): Promise<boolean> {
  const identity = await computeFileIdentity(candidate.path).catch(() => undefined);
  if (!identity || identity.path !== candidate.path) return false;
  const fingerprint = computeTargetFingerprint(identity, candidate.version, candidate.managedDigest);
  return fingerprint === candidate.fingerprint;
}
