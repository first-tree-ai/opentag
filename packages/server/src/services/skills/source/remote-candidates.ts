import {
  declaredSkillContainers,
  discoverSkillDirectories,
  isReservedSkillName,
  parseSkillManifest,
  type RemoteSkillCandidate,
  type RemoteSkillUnavailableReason,
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_MANIFEST_FILE,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_MAX_ENTRIES,
  SKILL_MAX_PATH_BYTES,
  SKILL_SOURCE_MAX_CANDIDATES,
  SKILL_UNPACKED_MAX_BYTES,
  SkillNameSchema,
  skillNameFromDirectory,
} from "@opentag/shared";
import { skillArchiveTooLarge } from "../errors.js";
import type { RawSkillEntry } from "../skill-archive-reader.js";
import { assertSkillEntryPaths } from "../skill-archive-reader.js";
import { type SkillSourceFile, type SkillSourceSnapshot, skillFingerprint } from "./source-snapshot.js";

/**
 * The bridge between a fetched source and the Skill contract: which directories in the source are
 * Skills, what the user is told about each, and how a chosen one becomes validated archive entries.
 *
 * Everything here is written against `SkillSourceSnapshot`, so a git clone, an unpacked artifact,
 * and a single downloaded `SKILL.md` are all handled by the same rules. Only the manifest is read
 * while listing: reading every file of every candidate would turn a preview of a large catalog into
 * a download of the whole catalog, and the two fields that would come from it (`fileCount`, `bytes`)
 * are optional detail.
 *
 * Two checks do run at listing time, both cheap and both about what a *name* can hide:
 *
 * - the canonical member rules, over paths only, so a candidate whose filenames a Skill archive
 *   cannot hold is reported as unusable instead of installing successfully and failing to
 *   materialize on the Computer; and
 * - a fingerprint over the listing, which the install compares against the preview. Without it the
 *   promise "what you previewed can have moved, and the result says so" would be false, because a
 *   ref or index rewritten at the same name would install quietly.
 *
 * A candidate that cannot be packaged at all is still listed, marked, and explained — dropping it
 * silently would leave the user wondering why the repository they pasted offers four Skills in
 * `--list` and two here.
 */

export interface MaterializedSkillFile {
  /** Path relative to the Skill directory. */
  path: string;
  body: Uint8Array;
  executable: boolean;
}

export interface RemoteSkillListing {
  candidate: RemoteSkillCandidate;
  /**
   * Re-derives the fingerprint from the same source. The installer calls it on a freshly read source
   * and compares it with the value the preview reported.
   */
  fingerprint: () => Promise<string>;
  /** Reads the Skill's own files. Called at install time, never while listing. */
  materialize: () => Promise<MaterializedSkillFile[]>;
}

export interface DiscoverRemoteSkillsInput {
  snapshot: SkillSourceSnapshot;
  subpath?: string;
  declaredContainers?: readonly string[];
  /** Names this Agent already owns, compared case-insensitively. */
  existingNames?: readonly string[];
  /** The `owner/repo@name` / `#ref@name` filter; only a candidate with this exact name is listed. */
  nameFilter?: string;
  maxCandidates?: number;
}

interface Member {
  path: string;
  executable: boolean;
  id: string;
}

/** The directory's files, keyed by path relative to the directory. For the root, the paths as they are. */
function membersOf(files: readonly SkillSourceFile[], directory: string): Member[] {
  const prefix = directory === "" || directory === "." ? "" : `${directory}/`;
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), executable: file.executable, id: file.id }));
}

interface ManifestReading {
  name: string;
  description: string;
  unavailableReason?: RemoteSkillUnavailableReason;
}

/**
 * The candidate's identity, read from its manifest.
 *
 * A manifest that cannot be read never hides the candidate: the directory name becomes the display
 * name and the reason is reported, which is what lets the UI say "this one is not installable and
 * why" instead of showing a shorter list than the repository has.
 */
async function readManifest(
  snapshot: SkillSourceSnapshot,
  directory: string,
  members: readonly { path: string }[],
): Promise<ManifestReading> {
  const displayName = skillNameFromDirectory(directory === "." ? "" : directory) || "skill";
  const manifest = members.find((member) => member.path === SKILL_MANIFEST_FILE);
  if (manifest === undefined) {
    return { name: displayName, description: "", unavailableReason: "manifest_invalid" };
  }
  const body = await snapshot.read(
    directory === "." || directory === "" ? SKILL_MANIFEST_FILE : `${directory}/${SKILL_MANIFEST_FILE}`,
  );
  if (body.byteLength > SKILL_MANIFEST_MAX_BYTES) {
    return { name: displayName, description: "", unavailableReason: "manifest_invalid" };
  }
  const parsed = parseSkillManifest(new TextDecoder().decode(body));
  if (!parsed.ok) return { name: displayName, description: "", unavailableReason: "manifest_invalid" };
  const { name, description } = parsed.manifest;
  if (!SkillNameSchema.safeParse(name).success) {
    return { name: displayName, description: "", unavailableReason: "manifest_invalid" };
  }
  if (isReservedSkillName(name)) {
    return {
      name,
      description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH),
      unavailableReason: "name_reserved",
    };
  }
  return { name, description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH) };
}

/** Bounds that a listing can see without reading file contents. */
function boundsReason(members: readonly { path: string }[]): RemoteSkillUnavailableReason | undefined {
  if (members.length > SKILL_MAX_ENTRIES) return "too_large";
  if (members.some((member) => member.path.length > SKILL_MAX_PATH_BYTES)) return "too_large";
  return undefined;
}

/**
 * Whether the canonical member rules accept this candidate's paths.
 *
 * The same rules the archive reader applies, over paths alone: a repository can hold a filename with
 * a backslash or a `..` segment, and packing it would produce a Skill the Computer's extractor
 * rejects. Reporting it here means the user is told, rather than an install claiming success for
 * something the runtime can never materialize.
 */
function pathReason(members: readonly { path: string }[]): RemoteSkillUnavailableReason | undefined {
  try {
    assertSkillEntryPaths(members.map((member) => member.path));
    return undefined;
  } catch {
    return "path_invalid";
  }
}

/**
 * The Skills in a source, in discovery order, each name appearing once.
 *
 * The first occurrence of a name wins, because selection is by name: two candidates called `demo`
 * would make "install demo" ambiguous. A later duplicate is dropped silently — the two directories
 * genuinely hold the same Skill, and the listing has no way to ask which one was meant. A
 * `nameFilter` is applied before the cap so that `owner/repo@skill` lists that Skill rather than
 * truncating a larger catalog to nothing.
 */
export async function discoverRemoteSkills(input: DiscoverRemoteSkillsInput): Promise<RemoteSkillListing[]> {
  const filter = input.nameFilter?.trim().toLowerCase();
  const maxCandidates = input.maxCandidates ?? SKILL_SOURCE_MAX_CANDIDATES;
  const directories = discoverSkillDirectories({
    paths: input.snapshot.files.map((file) => file.path),
    ...(input.subpath === undefined ? {} : { subpath: input.subpath }),
    declaredContainers: await pluginContainers(input),
  });

  const listings: RemoteSkillListing[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    if (listings.length >= maxCandidates) break;
    const listing = await listingFor(input, directory.path, filter);
    if (listing === undefined) continue;
    const key = listing.candidate.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    listings.push(listing);
  }
  return listings;
}

/**
 * One candidate, or `undefined` when it does not match the filter.
 *
 * The name filter is checked here, before the caller's cap, so `owner/repo@skill` lists that Skill
 * rather than truncating a larger catalog to nothing.
 */
async function listingFor(
  input: DiscoverRemoteSkillsInput,
  directory: string,
  filter: string | undefined,
): Promise<RemoteSkillListing | undefined> {
  const existing = new Set((input.existingNames ?? []).map((name) => name.toLowerCase()));
  const members = membersOf(input.snapshot.files, directory);
  const manifest = await readManifest(input.snapshot, directory, members);
  if (filter !== undefined && manifest.name.toLowerCase() !== filter) return undefined;
  const reason = manifest.unavailableReason ?? boundsReason(members) ?? pathReason(members);
  return {
    candidate: {
      name: manifest.name,
      description: manifest.description,
      path: directory === "" ? "." : directory,
      fileCount: members.length,
      alreadyInstalled: existing.has(manifest.name.toLowerCase()),
      fingerprint: skillFingerprint(members),
      ...(reason === undefined ? {} : { unavailableReason: reason }),
    },
    fingerprint: () => Promise.resolve(skillFingerprint(members)),
    materialize: () => materializeMembers(input.snapshot, directory, members),
  };
}

/**
 * The containers a plugin manifest declares, read from the source when it carries one.
 *
 * The documents are read here rather than inside discovery because they are file *contents*, and
 * discovery is deliberately a pure function of a path listing. The returned containers are relative
 * to the search root, which is what discovery expects: a manifest inside a subpath describes plugins
 * inside that subpath.
 */
async function pluginContainers(input: DiscoverRemoteSkillsInput): Promise<string[]> {
  const paths = new Set(input.snapshot.files.map((file) => file.path));
  const prefix = input.subpath === undefined ? "" : `${input.subpath.replace(/\/$/, "")}/`;
  const marketplacePath = `${prefix}.claude-plugin/marketplace.json`;
  const pluginPath = `${prefix}.claude-plugin/plugin.json`;
  const documents: { marketplace?: string; plugin?: string } = {};
  if (paths.has(marketplacePath)) {
    documents.marketplace = new TextDecoder().decode(await input.snapshot.read(marketplacePath));
  }
  if (paths.has(pluginPath)) {
    documents.plugin = new TextDecoder().decode(await input.snapshot.read(pluginPath));
  }
  if (documents.marketplace === undefined && documents.plugin === undefined) return [];
  return declaredSkillContainers(documents);
}

async function materializeMembers(
  snapshot: SkillSourceSnapshot,
  directory: string,
  members: readonly { path: string; executable: boolean }[],
): Promise<MaterializedSkillFile[]> {
  const files: MaterializedSkillFile[] = [];
  let total = 0;
  for (const member of members) {
    const sourcePath = directory === "" || directory === "." ? member.path : `${directory}/${member.path}`;
    const body = await snapshot.read(sourcePath);
    total += body.byteLength;
    if (total > SKILL_UNPACKED_MAX_BYTES || total > SKILL_ARCHIVE_MAX_BYTES) throw skillArchiveTooLarge();
    files.push({ path: member.path, body, executable: member.executable });
  }
  return files;
}

/** The validated entries for one Skill, ready for the canonical packer. */
export function skillArchiveEntries(files: readonly MaterializedSkillFile[]): RawSkillEntry[] {
  return files.map((file) => ({ path: file.path, body: file.body, mode: file.executable ? 0o755 : 0o644 }));
}
