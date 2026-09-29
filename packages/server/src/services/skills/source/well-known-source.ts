import { createHash } from "node:crypto";
import {
  isReservedSkillName,
  normalizeSourcePath,
  parseSkillManifest,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_ERROR_CODES,
  SKILL_MANIFEST_FILE,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
  SKILL_SOURCE_EXTRACT_MAX_BYTES,
  SKILL_SOURCE_EXTRACT_MAX_FILES,
  SKILL_SOURCE_MAX_CANDIDATES,
  SKILL_SOURCE_PREVIEW_CONTENT_MAX_BYTES,
  SkillNameSchema,
} from "@opentag/shared";
import { SkillServiceError, skillSourceInvalid, skillSourceTooLarge } from "../errors.js";
import { readSkillEntries } from "../skill-archive-reader.js";
import type { MaterializedSkillFile, RemoteSkillListing } from "./remote-candidates.js";
import type { SkillSourceFetcher } from "./source-fetcher.js";
import { contentId, skillFingerprint } from "./source-snapshot.js";

/**
 * Well-known Skill discovery (RFC 8615), the format a host publishes when it is not a git repository.
 *
 * Two document versions are read:
 *
 * - `0.2.0`, `$schema` = `https://schemas.agentskills.io/discovery/0.2.0/schema.json`: each entry
 *   names a single artifact (`type` `skill-md` or `archive`) with a `digest` that is verified before
 *   anything is installed.
 * - `0.1.0`, the legacy directory layout: each entry lists its `files`, fetched relative to the
 *   entry's own directory under the index.
 *
 * The index is probed at `<url>/.well-known/agent-skills/index.json` and then
 * `<url>/.well-known/skills/index.json`. There is deliberately **no** origin-root fallback: a
 * scoped URL whose own index yields nothing must not silently install the site's entire catalog.
 * "No index at all" is reported as such, so the caller can fall back to reading the URL itself as a
 * direct download; "an index with no usable entry" is a source with no Skills.
 *
 * An entry whose published metadata cannot be used — a missing artifact URL, a digest that is not a
 * sha256, a name that is not a Skill name — is skipped. The alternative, listing it and failing at
 * install time, would offer the user something that can never work.
 */

const DISCOVERY_SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const INDEX_MAX_BYTES = 512 * 1024;
const WELL_KNOWN_PATHS: readonly string[] = [".well-known/agent-skills/index.json", ".well-known/skills/index.json"];
const BARE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** The RFC's v0.2 digest form: `sha256:<64 lowercase hex>`. */
const PREFIXED_SHA256_PATTERN = /^sha256:([0-9a-f]{64})$/;
const ZIP_MAGIC = [0x50, 0x4b];
const GZIP_MAGIC = [0x1f, 0x8b];

export type WellKnownIndexResult = { found: false } | { found: true; listings: RemoteSkillListing[] };

interface IndexEntryV2 {
  name: string;
  description: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
}

interface IndexEntryV1 {
  name: string;
  description: string;
  files: string[];
}

interface ParsedIndex {
  version: "0.1.0" | "0.2.0";
  entries: (IndexEntryV2 | IndexEntryV1)[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Classifies one index document. `undefined` means the document is not an index this platform can
 * use, which the caller treats as a reason to look at the other index path. An index that parses but
 * holds no usable entry is *not* `undefined`: it is a host that publishes Skills, and none of them
 * can be installed — a different answer from "this host publishes nothing".
 */
export function parseWellKnownIndex(text: string): ParsedIndex | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const root = objectValue(document);
  if (root === undefined || !Array.isArray(root.skills)) return undefined;
  if (root.$schema === DISCOVERY_SCHEMA_V2) {
    return { version: "0.2.0", entries: root.skills.map(entryV2).filter((entry) => entry !== undefined) };
  }
  if (root.$schema !== undefined) return undefined;
  return { version: "0.1.0", entries: root.skills.map(entryV1).filter((entry) => entry !== undefined) };
}

/** A Skill name the platform can install, or `undefined` when the entry is unusable. */
/**
 * The digest in its canonical form: 64 lowercase hex characters, with or without the `sha256:`
 * prefix the RFC requires. The ecosystem's own CLI still publishes bare hex, so both spellings are
 * read; the normalized value is what a fingerprint is built from, so a publisher that switches
 * spelling between a preview and an install does not look like a content change.
 */
export function normalizeDigest(value: string): string | undefined {
  const lower = value.trim().toLowerCase();
  const prefixed = PREFIXED_SHA256_PATTERN.exec(lower);
  if (prefixed?.[1] !== undefined) return prefixed[1];
  return BARE_SHA256_PATTERN.test(lower) ? lower : undefined;
}

function usableName(value: unknown): string | undefined {
  const name = stringValue(value);
  if (name === undefined || !SkillNameSchema.safeParse(name).success) return undefined;
  return name;
}

function entryV2(value: unknown): IndexEntryV2 | undefined {
  const entry = objectValue(value);
  if (entry === undefined) return undefined;
  const name = usableName(entry.name);
  const type = entry.type === "skill-md" || entry.type === "archive" ? entry.type : undefined;
  const url = stringValue(entry.url);
  const rawDigest = stringValue(entry.digest);
  const description = stringValue(entry.description);
  if (name === undefined || type === undefined || url === undefined || rawDigest === undefined) return undefined;
  const digest = normalizeDigest(rawDigest);
  if (digest === undefined || description === undefined) return undefined;
  return { name, type, url, digest, description };
}

function entryV1(value: unknown): IndexEntryV1 | undefined {
  const entry = objectValue(value);
  if (entry === undefined) return undefined;
  const name = usableName(entry.name);
  const description = stringValue(entry.description);
  if (name === undefined || description === undefined || !Array.isArray(entry.files)) return undefined;
  // The entry list is bounded before anything is fetched: an unbounded array would otherwise become
  // one request and one retained body per member.
  if (entry.files.length > SKILL_SOURCE_EXTRACT_MAX_FILES) return undefined;
  const files = entry.files
    .map((file) => (typeof file === "string" ? normalizeSourcePath(file) : undefined))
    .filter((file): file is string => file !== undefined);
  if (!files.includes(SKILL_MANIFEST_FILE)) return undefined;
  return { name, description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH), files };
}

function descriptionOf(entry: IndexEntryV1 | IndexEntryV2): string {
  return entry.description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH);
}

function isArchive(bytes: Uint8Array): boolean {
  return (
    ZIP_MAGIC.every((value, index) => bytes[index] === value) ||
    GZIP_MAGIC.every((value, index) => bytes[index] === value)
  );
}

/** Bytes to materialized files: an archive is unpacked, anything else must be a `SKILL.md`. */
async function filesFromArtifact(bytes: Uint8Array): Promise<MaterializedSkillFile[]> {
  if (isArchive(bytes)) {
    const format = ZIP_MAGIC.every((value, index) => bytes[index] === value) ? "zip" : "tar.gz";
    const entries = await readSkillEntries(bytes, format, {
      maxArchiveBytes: SKILL_SOURCE_DOWNLOAD_MAX_BYTES,
      maxUnpackedBytes: SKILL_SOURCE_EXTRACT_MAX_BYTES,
    });
    if (entries.length === 0) throw skillSourceInvalid("That Skill's artifact is empty");
    return entries.map((entry) => ({
      path: entry.path,
      body: entry.body,
      executable: (entry.mode & 0o111) !== 0,
    }));
  }
  if (bytes.byteLength === 0 || bytes.byteLength > SKILL_MANIFEST_MAX_BYTES) {
    throw skillSourceInvalid("That Skill's artifact is not a SKILL.md or an archive");
  }
  const parsed = parseSkillManifest(new TextDecoder().decode(bytes));
  if (!parsed.ok) throw skillSourceInvalid("That Skill's artifact is not a SKILL.md or an archive");
  return [{ path: SKILL_MANIFEST_FILE, body: bytes, executable: false }];
}

function indexBase(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function indexUrl(base: string, path: string): string | undefined {
  try {
    return new URL(path, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * The files of one legacy entry, downloaded within one budget.
 *
 * The legacy layout publishes no content hash, so the only way to know what it offers is to read it.
 * The budget is what keeps that bounded: each file may take what the per-download cap allows and no
 * more than the Skill has left, and the total may never exceed the entry's unpacked ceiling.
 */
async function legacyEntryFiles(
  entry: IndexEntryV1,
  fetcher: SkillSourceFetcher,
  indexDirectory: string,
  budget: { remaining: number },
): Promise<MaterializedSkillFile[]> {
  const files: MaterializedSkillFile[] = [];
  for (const file of entry.files) {
    const url = indexUrl(indexDirectory, `${entry.name}/${file}`);
    if (url === undefined) throw skillSourceInvalid("That Skill's index declares an unusable file path");
    const allowance = Math.min(SKILL_SOURCE_DOWNLOAD_MAX_BYTES, budget.remaining);
    if (allowance <= 0) throw skillSourceTooLarge();
    const { bytes } = await fetcher.fetchBytes(url, allowance);
    budget.remaining -= bytes.byteLength;
    if (budget.remaining < 0) throw skillSourceTooLarge();
    files.push({ path: file, body: bytes, executable: false });
  }
  return files;
}

/** The content identity of an entry's files, in the same shape a repository or artifact reports. */
function contentFingerprint(files: readonly MaterializedSkillFile[]): string {
  return skillFingerprint(
    files.map((file) => ({ path: file.path, id: contentId(file.body), executable: file.executable })),
  );
}

function versionedListing(entry: IndexEntryV2, artifactUrl: string, fetcher: SkillSourceFetcher): RemoteSkillListing {
  // The index publishes the artifact's content hash, and the install verifies it, so it is a complete
  // identity for what the preview offered: a publisher that swaps the index entry changes this value,
  // and a publisher that swaps the artifact without touching the index fails the digest check.
  const fingerprint = `sha256:${entry.digest}`;
  return {
    candidate: {
      name: entry.name,
      description: descriptionOf(entry),
      path: entry.name,
      alreadyInstalled: false,
      fingerprint,
      ...(isReservedSkillName(entry.name) ? { unavailableReason: "name_reserved" } : {}),
    },
    fingerprint: () => Promise.resolve(fingerprint),
    async materialize() {
      const { bytes } = await fetcher.fetchBytes(artifactUrl);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== entry.digest) {
        throw skillSourceInvalid("That Skill's artifact does not match the digest its index published");
      }
      if (bytes.byteLength > SKILL_ARCHIVE_MAX_BYTES) {
        throw skillSourceInvalid("That Skill's artifact is larger than a Skill archive may be");
      }
      return filesFromArtifact(bytes);
    },
  };
}

/**
 * One legacy entry, bound to its content.
 *
 * The v0.1 layout publishes no content hash, so a declared-file-list fingerprint would let a
 * publisher change `SKILL.md` — or any payload — and still install as if nothing had moved. The
 * preview therefore reads the entry's files (within a bounded budget) and fingerprints what it read,
 * and the install reads them again and compares. The cost is the format's: unlike a v0.2 index or a
 * repository tree, v0.1 carries no content identity to rely on.
 *
 * `undefined` means the preview's content budget is spent; the entry is left out rather than listed
 * without the binding the selection contract promises.
 */
async function legacyListing(
  entry: IndexEntryV1,
  fetcher: SkillSourceFetcher,
  indexDirectory: string,
  previewBudget: { remaining: number },
): Promise<RemoteSkillListing | undefined> {
  const scope = { remaining: Math.min(SKILL_SOURCE_EXTRACT_MAX_BYTES, previewBudget.remaining) };
  if (scope.remaining <= 0) return undefined;
  let fingerprint: string;
  try {
    fingerprint = contentFingerprint(await legacyEntryFiles(entry, fetcher, indexDirectory, scope));
  } catch (error) {
    if (error instanceof SkillServiceError && error.code === SKILL_ERROR_CODES.SOURCE_TOO_LARGE) return undefined;
    throw error;
  }
  previewBudget.remaining = scope.remaining;
  return {
    candidate: {
      name: entry.name,
      description: descriptionOf(entry),
      path: entry.name,
      fileCount: entry.files.length,
      alreadyInstalled: false,
      fingerprint,
      ...(isReservedSkillName(entry.name) ? { unavailableReason: "name_reserved" } : {}),
    },
    fingerprint: async () => {
      const budget = { remaining: SKILL_SOURCE_EXTRACT_MAX_BYTES };
      return contentFingerprint(await legacyEntryFiles(entry, fetcher, indexDirectory, budget));
    },
    materialize: () => legacyEntryFiles(entry, fetcher, indexDirectory, { remaining: SKILL_SOURCE_EXTRACT_MAX_BYTES }),
  };
}

interface IndexProbe {
  text: string;
  indexUrl: string;
}

/** Probes one index path. An absent index is `undefined`; a broken one is not the same thing. */
async function probe(fetcher: SkillSourceFetcher, base: string, path: string): Promise<IndexProbe | undefined> {
  const url = indexUrl(base, path);
  if (url === undefined) return undefined;
  const response = await fetcher.fetchBytesAllowMissing(url, INDEX_MAX_BYTES);
  if (response.status < 200 || response.status >= 300) return undefined;
  return { text: new TextDecoder().decode(response.bytes), indexUrl: response.url };
}

/**
 * Resolves the Skills a well-known host publishes, or reports that it publishes no index at all.
 *
 * A probe that answers with a broken document is an error rather than an absence: the host claims to
 * publish Skills, and installing nothing while saying "no Skills" would be a lie about a deployment
 * problem the publisher can fix.
 */
export interface WellKnownOptions {
  existingNames?: readonly string[];
  maxCandidates?: number;
}

export async function resolveWellKnownSource(
  fetcher: SkillSourceFetcher,
  url: string,
  options: WellKnownOptions = {},
): Promise<WellKnownIndexResult> {
  const base = indexBase(url);
  let broken: IndexProbe | undefined;
  for (const path of WELL_KNOWN_PATHS) {
    const probeResult = await probe(fetcher, base, path);
    if (probeResult === undefined) continue;
    const parsed = parseWellKnownIndex(probeResult.text);
    if (parsed === undefined) {
      broken ??= probeResult;
      continue;
    }
    return { found: true, listings: await listingsFrom(parsed, probeResult, fetcher, options) };
  }
  if (broken !== undefined) throw skillSourceInvalid("That host's Skill index could not be read");
  return { found: false };
}

/**
 * The listings of one index, capped like every other source.
 *
 * The cap is applied here rather than by the caller because a catalog can be arbitrarily long and the
 * response schema rejects more than `SKILL_SOURCE_MAX_CANDIDATES`; truncating is the preview's job.
 * It also bounds the legacy content budget below, since at most this many entries are ever read.
 */
async function listingsFrom(
  parsed: ParsedIndex,
  probe: IndexProbe,
  fetcher: SkillSourceFetcher,
  options: WellKnownOptions,
): Promise<RemoteSkillListing[]> {
  const existing = new Set((options.existingNames ?? []).map((name) => name.toLowerCase()));
  const maxCandidates = options.maxCandidates ?? SKILL_SOURCE_MAX_CANDIDATES;
  const state = {
    indexDirectory: new URL(".", probe.indexUrl).toString(),
    // The legacy layout's content budget, shared across its entries; v0.2 spends none of it.
    previewBudget: { remaining: SKILL_SOURCE_PREVIEW_CONTENT_MAX_BYTES },
    maxCandidates,
  };
  const listings: RemoteSkillListing[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.entries) {
    if (listings.length >= maxCandidates) break;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    const listing = await oneListing(parsed.version, entry, probe, fetcher, state);
    if (listing === undefined) break;
    seen.add(key);
    listing.candidate.alreadyInstalled = existing.has(key);
    listings.push(listing);
  }
  return listings;
}

/**
 * One entry as a listing, or `undefined` when the legacy preview has spent its content budget.
 *
 * A v0.2 entry names an artifact with a published digest, so it costs nothing to list; a v0.1 entry
 * has to be read to be identified, which is why only that version can come back `undefined`.
 */
async function oneListing(
  version: ParsedIndex["version"],
  entry: IndexEntryV1 | IndexEntryV2,
  probe: IndexProbe,
  fetcher: SkillSourceFetcher,
  state: { indexDirectory: string; previewBudget: { remaining: number }; maxCandidates: number },
): Promise<RemoteSkillListing | undefined> {
  if (version === "0.2.0") {
    const artifactUrl = indexUrl(probe.indexUrl, (entry as IndexEntryV2).url);
    // An entry whose artifact URL cannot be resolved names nothing to fetch; it is not listed.
    if (artifactUrl === undefined) return undefined;
    return versionedListing(entry as IndexEntryV2, artifactUrl, fetcher);
  }
  return legacyListing(entry as IndexEntryV1, fetcher, state.indexDirectory, state.previewBudget);
}
