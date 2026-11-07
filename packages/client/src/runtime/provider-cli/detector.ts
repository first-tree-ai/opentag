import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";
import semver from "semver";
import { createLogger } from "../../observability/logger.js";
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
const logger = createLogger("runtime-provider-cli-detector");

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
  const status = await lstat(canonical).catch((error: unknown) => {
    logger.debug({ code: "path_entry_stat_failed", error: String(error) }, "Provider CLI PATH entry stat failed");
    return undefined;
  });
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

async function validateCandidateFileAndFormat(
  canonical: string,
  platform: ProviderCliDetectOptions["platform"],
  arch: ProviderCliDetectOptions["arch"],
): Promise<string | undefined> {
  const status = await lstat(canonical).catch((error: unknown) => {
    logger.debug({ code: "candidate_stat_failed", error: String(error) }, "Provider CLI candidate stat failed");
    return undefined;
  });
  if (!status) return "not-found";
  if (!status.isFile() || status.isSymbolicLink()) return "not-regular-file";
  if ((status.mode & 0o111) === 0) return "not-executable";
  if ((status.mode & 0o002) !== 0) return "world-writable";

  const header = await readExecutableHeader(canonical).catch((error: unknown) => {
    logger.debug(
      { code: "candidate_header_read_failed", error: String(error) },
      "Provider CLI candidate header read failed",
    );
    return undefined;
  });
  if (!header) return "unreadable";
  const format = inspectExecutableFormat(header);
  if (format.kind === "unknown") return "unrecognized-format";
  if (!executableFormatSupportsHost(format, platform, arch)) {
    return "wrong-platform-architecture";
  }
  return undefined;
}

function probeFailureReason(code: string): string {
  if (code === "unparseable_version") return "unparseable-version";
  if (code === "version_incompatible") return "version-incompatible";
  return "probe-failed";
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
  const validationReason = await validateCandidateFileAndFormat(canonical, options.platform, options.arch);
  if (validationReason) return { reason: validationReason };

  const identity = await computeFileIdentity(canonical).catch((error: unknown) => {
    logger.debug({ code: "candidate_identity_failed", error: String(error) }, "Provider CLI candidate identity failed");
    return undefined;
  });
  if (!identity) return { reason: "not-found" };
  const probed = await probeProviderCliExecutable(canonical, options.entry, {
    execFile,
  });
  if (probed.status === "failed") {
    return { reason: probeFailureReason(probed.code) };
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

interface CanonicalLayoutPaths {
  readonly launcherCanonical: string | undefined;
  readonly accountHome: string;
  readonly layoutRoot: string;
}

async function resolveCanonicalLayoutPaths(options: ProviderCliDetectOptions): Promise<CanonicalLayoutPaths> {
  const launcherPath = providerCliLauncherPath(options.layout, options.entry.command);
  const launcherCanonical = await realpath(launcherPath).catch((error: unknown) => {
    logger.debug(
      { code: "launcher_realpath_failed", error: String(error) },
      "Provider CLI launcher canonicalization failed",
    );
    return undefined;
  });
  // PATH candidates are canonicalized by realpath; the account root and protected
  // roots must be canonical too, or symlinked prefixes (e.g. /var on macOS) never match.
  const accountHome = await realpath(options.layout.accountHome).catch((error: unknown) => {
    logger.debug(
      { code: "account_home_realpath_failed", error: String(error) },
      "Provider CLI account home canonicalization failed",
    );
    return options.layout.accountHome;
  });
  const layoutRoot = await realpath(options.layout.root).catch((error: unknown) => {
    logger.debug(
      { code: "layout_root_realpath_failed", error: String(error) },
      "Provider CLI layout root canonicalization failed",
    );
    return resolveProviderCliAccountLayout(accountHome, options.platform).root;
  });
  return { launcherCanonical, accountHome, layoutRoot };
}

async function resolveExecutableInDir(dir: string, command: string): Promise<string | undefined> {
  const candidatePath = join(dir, command);
  try {
    await access(candidatePath, constants.X_OK);
    return await realpath(candidatePath);
  } catch (error) {
    logger.debug(
      { code: "path_candidate_resolution_failed", error: String(error) },
      "Provider CLI PATH candidate resolution failed",
    );
    return undefined;
  }
}

interface PathScanState {
  readonly candidates: ProviderCliCandidate[];
  readonly ignored: IgnoredProviderCliCandidate[];
  readonly pathRanks: Map<string, number>;
  readonly execFile: ProviderCliExecFile;
  readonly digests: ReadonlySet<string>;
  readonly paths: CanonicalLayoutPaths;
}

function isManagedOrLauncherPath(canonical: string, paths: CanonicalLayoutPaths): boolean {
  return canonical === paths.launcherCanonical || canonical.startsWith(`${paths.layoutRoot}${sep}`);
}

async function resolveNewExternalCandidateFromEntry(
  rawEntry: string,
  currentRank: number,
  options: ProviderCliDetectOptions,
  state: PathScanState,
  seenCanonical: Set<string>,
): Promise<{ canonical: string; dir: string } | undefined> {
  if (rawEntry.length === 0) return undefined; // An empty entry means the current directory: never used.
  const directory = await canonicalSafeDirectory(rawEntry, options.platform, state.paths.accountHome);
  if ("reason" in directory) {
    // Nonexistent directories are common PATH leftovers; only unsafe entries are reported.
    if (directory.reason !== "unreadable-path-entry") {
      state.ignored.push({ path: rawEntry, reason: directory.reason });
    }
    return undefined;
  }
  const canonical = await resolveExecutableInDir(directory.dir, options.entry.command);
  if (!canonical) return undefined;

  if (seenCanonical.has(canonical)) {
    state.pathRanks.set(canonical, Math.min(state.pathRanks.get(canonical) ?? currentRank, currentRank));
    return undefined;
  }
  seenCanonical.add(canonical);
  state.pathRanks.set(canonical, currentRank);

  // The account-global launcher and anything inside the OpenTag-managed root are
  // classified as managed and never offered again as external candidates.
  if (isManagedOrLauncherPath(canonical, state.paths)) {
    return undefined;
  }
  return { canonical, dir: directory.dir };
}

async function scanPathCandidates(options: ProviderCliDetectOptions, state: PathScanState): Promise<void> {
  const pathEntries = (options.env.PATH ?? "").split(delimiter).slice(0, PATH_ENTRY_LIMIT);
  const seenCanonical = new Set<string>();
  let rank = 0;
  let sequence = 0;
  let probedCandidateCount = 0;

  for (const rawEntry of pathEntries) {
    const currentRank = rank;
    rank += 1;
    const resolved = await resolveNewExternalCandidateFromEntry(rawEntry, currentRank, options, state, seenCanonical);
    if (!resolved) continue;

    if (probedCandidateCount >= CANDIDATE_PROBE_LIMIT) {
      state.ignored.push({ path: rawEntry, reason: "candidate-probe-limit-reached" });
      break;
    }
    probedCandidateCount += 1;

    const assessed = await assessCandidatePath(resolved.canonical, options, state.execFile, state.digests);
    if ("reason" in assessed) {
      state.ignored.push({ path: resolved.canonical, sourceDir: resolved.dir, ...assessed });
      continue;
    }
    sequence += 1;
    state.candidates.push({
      id: `candidate-${sequence}`,
      provider: options.provider,
      kind: "external",
      path: resolved.canonical,
      sourceDir: resolved.dir,
      version: assessed.version,
      trust: assessed.trust,
      fingerprint: assessed.fingerprint,
      pathRank: currentRank,
      incumbent: false,
    });
  }
}

function normalizeIncumbentIgnoreReason(selection: ProviderCliSelectionRecord, rawReason: string): string {
  if (selection.selection.kind === "external" && (rawReason === "not-found" || rawReason === "not-regular-file")) {
    return "external-path-invalid";
  }
  return rawReason;
}

async function mergeIncumbentSelection(
  selection: ProviderCliSelectionRecord,
  options: ProviderCliDetectOptions,
  state: Pick<PathScanState, "candidates" | "ignored" | "pathRanks" | "execFile" | "digests">,
): Promise<void> {
  const targetPath =
    selection.selection.kind === "managed" ? selection.selection.targetPath : selection.selection.executablePath;
  const managedDigest = managedDigestOf(selection);
  const incumbent = await assessCandidatePath(targetPath, options, state.execFile, state.digests, managedDigest);
  if ("reason" in incumbent) {
    state.ignored.push({
      path: targetPath,
      sourceDir: "selection",
      reason: normalizeIncumbentIgnoreReason(selection, incumbent.reason),
    });
    return;
  }

  const incumbentPath = incumbent.identity.path;
  const merged: ProviderCliCandidate = {
    id: "candidate-selection",
    provider: options.provider,
    kind: selection.selection.kind,
    path: incumbentPath,
    sourceDir: state.candidates.find((candidate) => candidate.path === incumbentPath)?.sourceDir ?? "selection",
    version: incumbent.version,
    trust: selection.selection.kind === "managed" ? "catalog-verified" : incumbent.trust,
    fingerprint: incumbent.fingerprint,
    ...(managedDigest ? { managedDigest } : {}),
    pathRank: state.pathRanks.get(incumbentPath) ?? Number.MAX_SAFE_INTEGER,
    incumbent: true,
  };
  if (options.mode === "managed-only" && merged.kind === "external") {
    state.ignored.push({ path: incumbentPath, sourceDir: "selection", reason: "managed-only" });
    return;
  }
  const existing = state.candidates.findIndex((candidate) => candidate.path === incumbentPath);
  if (existing >= 0) state.candidates.splice(existing, 1, merged);
  else state.candidates.push(merged);
}

export async function detectProviderCliCandidates(options: ProviderCliDetectOptions): Promise<ProviderCliDetection> {
  const execFile = options.execFile ?? defaultProviderCliExecFile;
  const digests = catalogExecutableDigests(options.entry);
  const candidates: ProviderCliCandidate[] = [];
  const ignored: IgnoredProviderCliCandidate[] = [];
  const pathRanks = new Map<string, number>();
  const paths = await resolveCanonicalLayoutPaths(options);
  const state: PathScanState = { candidates, ignored, pathRanks, execFile, digests, paths };

  // --- PATH scan (skipped entirely in managed-only mode). ---
  if (options.mode === "auto") {
    await scanPathCandidates(options, state);
  }

  // --- The current selection is always part of the candidate set. ---
  if (options.selection) {
    await mergeIncumbentSelection(options.selection, options, state);
  }

  return { candidates, ignored };
}

function compareProviderCliCandidates(left: ProviderCliCandidate, right: ProviderCliCandidate): number {
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
}

function explainWinnerReason(winner: ProviderCliCandidate, runnerUp: ProviderCliCandidate | undefined): string {
  if (!runnerUp || semver.compare(winner.version, runnerUp.version) !== 0) {
    return "newest compatible version";
  }
  if (winner.trust !== runnerUp.trust) return "catalog-verified trust";
  if (winner.incumbent && !runnerUp.incumbent) return "current selection";
  return "first in PATH";
}

function explainLoserReason(winner: ProviderCliCandidate, loser: ProviderCliCandidate): string {
  if (semver.compare(winner.version, loser.version) !== 0) return "older compatible version";
  if (winner.trust !== loser.trust) return "same version with lower trust";
  if (loser.incumbent !== winner.incumbent) return "same version, not the current selection";
  return "same version, later in PATH";
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
  const ordered = [...candidates].sort(compareProviderCliCandidates);
  const reasons = new Map<string, string>();
  const winner = ordered[0];
  if (winner) {
    reasons.set(winner.id, explainWinnerReason(winner, ordered[1]));
    for (const loser of ordered.slice(1)) {
      reasons.set(loser.id, explainLoserReason(winner, loser));
    }
  }
  return { ordered, reasons };
}

/**
 * Reopen a winner by canonical path and recompute its fingerprint immediately before
 * persistence. A changed candidate is rejected so the caller can rank again.
 */
export async function verifyProviderCliCandidateFingerprint(candidate: ProviderCliCandidate): Promise<boolean> {
  const identity = await computeFileIdentity(candidate.path).catch((error: unknown) => {
    logger.debug(
      { code: "candidate_identity_failed", error: String(error) },
      "Provider CLI candidate identity failed during fingerprint verification",
    );
    return undefined;
  });
  if (!identity || identity.path !== candidate.path) return false;
  const fingerprint = computeTargetFingerprint(identity, candidate.version, candidate.managedDigest);
  return fingerprint === candidate.fingerprint;
}
