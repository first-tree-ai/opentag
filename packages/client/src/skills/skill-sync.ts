import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  type AgentRuntimeProvider,
  type RuntimeSkillManifest,
  SKILL_MARKER_FILE,
  type SkillInstallMarker,
  SkillInstallMarkerSchema,
} from "@opentag/shared";
import type { ClientLogger } from "../observability/logger.js";
import { ensurePrivateDirectory } from "../storage/durable-file.js";
import { extractSkillArchive, SKILL_CONTENT_SIDECAR_FILE } from "./skill-archive.js";

/**
 * Materializes the Agent's enabled Skills into the Provider's skill directory at runtime start.
 *
 * Sync is deliberately soft: a network failure, a 404 from an older server, an unavailable object
 * store, or a corrupt bundle is logged and swallowed, and the caller proceeds with whatever is
 * already on disk. Losing Skills must never cost the Agent its turn. Only directories carrying the
 * platform marker are ever read, modified, or removed; a directory without one belongs to the
 * Agent or to a Context Tree and is left byte-for-byte alone.
 *
 * Every target is Agent-scoped. Codex is verified (0.153.4) to discover `<cwd>/.agents/skills`,
 * alongside `$CODEX_HOME/skills` and `~/.agents/skills`; the shared OS account home is never a
 * target, because every Agent on the Computer shares it and writing there would leak one Agent's
 * Skills to its siblings.
 */

export { SKILL_CONTENT_SIDECAR_FILE };
export const SKILL_SYNC_DEFAULT_BUDGET_MS = 15_000;

export interface SkillSyncApi {
  getComputerSkillManifest(
    machineToken: string,
    agentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeSkillManifest>;
  openComputerSkillBundle(
    machineToken: string,
    agentId: string,
    skillId: string,
    options?: { signal?: AbortSignal },
  ): Promise<Response>;
}

export interface SkillSyncManagerOptions {
  readonly api: SkillSyncApi;
  readonly machineToken: () => Promise<string>;
  readonly logger: ClientLogger;
  readonly now?: () => number;
  readonly budgetMs?: number;
}

export interface SkillSyncAgentInput {
  readonly agentId: string;
  readonly cwd: string;
  readonly provider: AgentRuntimeProvider;
}

export type SkillSyncStatus = "synced" | "unavailable";

export interface SkillSyncResult {
  /** Absolute paths of the installed skill directories (Pi consumes these as `--skill`). */
  readonly skillPaths: readonly string[];
  readonly status: SkillSyncStatus;
}

export interface SkillDirectoryMarkerInput {
  readonly skillId: string;
  readonly archiveSha256: string;
}

interface ManagedDirectory {
  readonly name: string;
  readonly path: string;
  readonly marker: SkillInstallMarker;
}

interface SkillInstallLayout {
  readonly root: string;
  readonly directoryName: (name: string) => string;
  /** Reverse of `directoryName`; `undefined` when the entry is not a platform directory. */
  readonly skillName: (dirName: string) => string | undefined;
}

const MARKER_MAX_BYTES = 4 * 1024;
/** The three Agent-workspace directories that hold provider skill materializations. */
const MATERIALIZATION_DOT_DIRECTORIES: ReadonlySet<string> = new Set([".claude", ".agents", ".opentag"]);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The roots, relative to an Agent workspace, that hold Agent-scoped Skills. */
export function skillRootForProvider(cwd: string, provider: AgentRuntimeProvider): string {
  if (provider === "codex") return join(cwd, ".agents", "skills");
  if (provider === "pi") return join(cwd, ".opentag", "skills");
  return join(cwd, ".claude", "skills");
}

function installLayout(input: SkillSyncAgentInput): SkillInstallLayout {
  return {
    root: skillRootForProvider(input.cwd, input.provider),
    directoryName: (name) => name,
    skillName: (dirName) => dirName,
  };
}

async function readMarker(path: string): Promise<SkillInstallMarker | undefined> {
  let raw: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MARKER_MAX_BYTES) return undefined;
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = SkillInstallMarkerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function listManagedDirectories(layout: SkillInstallLayout): Promise<Map<string, ManagedDirectory>> {
  const managed = new Map<string, ManagedDirectory>();
  let names: string[];
  try {
    names = await readdir(layout.root);
  } catch {
    return managed;
  }
  for (const dirName of names) {
    const name = layout.skillName(dirName);
    if (name === undefined) continue;
    const path = join(layout.root, dirName);
    const marker = await readMarker(join(path, SKILL_MARKER_FILE));
    if (marker) managed.set(name, { name, path, marker });
  }
  return managed;
}

/** Content digest of a directory, ignoring the platform marker and its sidecar. */
export async function hashSkillDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashSkillTree(root, "", hash);
  return hash.digest("hex");
}

async function hashSkillTree(directory: string, prefix: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) await hashSkillEntry(directory, prefix, entry, hash);
}

async function hashSkillEntry(
  directory: string,
  prefix: string,
  entry: Dirent,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  if (entry.name === SKILL_MARKER_FILE || entry.name === SKILL_CONTENT_SIDECAR_FILE) return;
  const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  const absolute = join(directory, entry.name);
  if (entry.isDirectory()) {
    hash.update(`d\0${rel}\0`);
    await hashSkillTree(absolute, rel, hash);
    return;
  }
  if (!entry.isFile()) return;
  hash.update(`f\0${rel}\0`);
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
}

async function readContentDigest(directory: string): Promise<string | undefined> {
  try {
    return (await readFile(join(directory, SKILL_CONTENT_SIDECAR_FILE), "utf8")).trim();
  } catch {
    return undefined;
  }
}

/**
 * Mark an existing directory as platform-managed so the next sync owns it.
 *
 * `skill push` calls this when the directory it uploaded is the Skill's own materialization
 * target; without it the authored directory would shadow its platform copy forever.
 */
export async function markSkillDirectoryManaged(directory: string, input: SkillDirectoryMarkerInput): Promise<void> {
  const target = resolve(directory);
  await writeFile(
    join(target, SKILL_MARKER_FILE),
    `${JSON.stringify({ skillId: input.skillId, archiveSha256: input.archiveSha256 })}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(target, SKILL_CONTENT_SIDECAR_FILE), `${await hashSkillDirectory(target)}\n`, {
    mode: 0o600,
  });
}

/** True when `directory` is where the platform would materialize `name`, regardless of provider. */
export function isSkillMaterializationTarget(directory: string, name: string): boolean {
  return resolveMaterializationWorkspace(directory, name) !== undefined;
}

/**
 * The Agent workspace that contains `directory` as one of its Skill materialization targets.
 *
 * Matched purely on the path shape `<workspace>/<.claude|.agents|.opentag>/skills/<name>`, walking
 * up from the directory itself, so adoption still works when the caller has `cd`-ed into the skill
 * directory. No provider or ambient cwd is needed.
 */
export function resolveMaterializationWorkspace(directory: string, name: string): string | undefined {
  const skillDirectory = resolve(directory);
  if (basename(skillDirectory) !== name) return undefined;
  const skillsRoot = dirname(skillDirectory);
  if (basename(skillsRoot) !== "skills") return undefined;
  const dotDirectory = dirname(skillsRoot);
  if (!MATERIALIZATION_DOT_DIRECTORIES.has(basename(dotDirectory))) return undefined;
  return dirname(dotDirectory);
}

async function downloadedBundle(
  api: SkillSyncApi,
  token: string,
  agentId: string,
  entry: RuntimeSkillManifest["skills"][number],
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await api.openComputerSkillBundle(token, agentId, entry.id, { signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== entry.archiveBytes) {
    throw new Error(`Skill bundle ${entry.name} has ${bytes.byteLength} bytes, expected ${entry.archiveBytes}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.archiveSha256) {
    throw new Error(`Skill bundle ${entry.name} failed its sha256 check`);
  }
  return bytes;
}

async function installBundle(
  layout: SkillInstallLayout,
  entry: RuntimeSkillManifest["skills"][number],
  bytes: Uint8Array,
): Promise<string> {
  await ensurePrivateDirectory(dirname(layout.root), layout.root);
  const staging = await mkdtemp(join(layout.root, ".opentag-skill-"));
  try {
    await extractSkillArchive(Readable.from(Buffer.from(bytes)), staging);
    await writeFile(
      join(staging, SKILL_MARKER_FILE),
      `${JSON.stringify({ skillId: entry.id, archiveSha256: entry.archiveSha256 })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(staging, SKILL_CONTENT_SIDECAR_FILE), `${await hashSkillDirectory(staging)}\n`, {
      mode: 0o600,
    });
    const destination = join(layout.root, layout.directoryName(entry.name));
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function quarantineConflict(
  cwd: string,
  name: string,
  source: string,
  nowMs: number,
  logger: ClientLogger,
): Promise<void> {
  const stamp = new Date(nowMs).toISOString().replaceAll(/[:.]/gu, "-");
  const target = join(cwd, ".opentag", "skill-conflicts", `${name}-${stamp}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rm(target, { recursive: true, force: true });
  await rename(source, target);
  logger.info({ code: "skill_conflict_quarantined", skill: name, target }, "Locally edited Skill was quarantined");
}

export class SkillSyncManager {
  readonly #api: SkillSyncApi;
  readonly #machineToken: () => Promise<string>;
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #budgetMs: number;

  constructor(options: SkillSyncManagerOptions) {
    this.#api = options.api;
    this.#machineToken = options.machineToken;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => Date.now());
    this.#budgetMs = options.budgetMs ?? SKILL_SYNC_DEFAULT_BUDGET_MS;
  }

  async ensureAgent(input: SkillSyncAgentInput): Promise<SkillSyncResult> {
    const layout = installLayout(input);
    const signal = AbortSignal.timeout(this.#budgetMs);
    try {
      const token = await this.#machineToken();
      const manifest = await this.#api.getComputerSkillManifest(token, input.agentId, { signal });
      const installed = await this.#reconcile(input, layout, manifest, token, signal);
      return { skillPaths: installed, status: "synced" };
    } catch (error) {
      this.#logger.warn(
        { code: "skill_sync_unavailable", reason: describeError(error) },
        "Agent Skill sync is unavailable; continuing with the Skills already on disk",
      );
      return { skillPaths: await this.#existingSkillPaths(layout), status: "unavailable" };
    }
  }

  async #existingSkillPaths(layout: SkillInstallLayout): Promise<string[]> {
    try {
      const managed = await listManagedDirectories(layout);
      return [...managed.values()].map((entry) => entry.path);
    } catch {
      return [];
    }
  }

  async #reconcile(
    input: SkillSyncAgentInput,
    layout: SkillInstallLayout,
    manifest: RuntimeSkillManifest,
    token: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const existing = await listManagedDirectories(layout);
    const desired = new Set(manifest.skills.map((entry) => entry.name));
    for (const entry of manifest.skills) {
      signal.throwIfAborted();
      const current = existing.get(entry.name);
      if (current && current.marker.archiveSha256 === entry.archiveSha256) {
        this.#logger.debug({ code: "skill_sync_skip", skill: entry.name }, "Skill is already current");
        continue;
      }
      if (!current && (await pathExists(join(layout.root, layout.directoryName(entry.name))))) {
        this.#logger.warn(
          { code: "skill_name_shadowed_locally", skill: entry.name },
          "An unmanaged directory shadows this Skill name; leaving it untouched",
        );
        continue;
      }
      // Download and verify before touching the old copy: a corrupt or truncated bundle must
      // never cost the Agent the Skill it already had.
      const bytes = await downloadedBundle(this.#api, token, input.agentId, entry, signal);
      if (current) await this.#retireManaged(input, entry.name, current);
      const started = this.#now();
      await installBundle(layout, entry, bytes);
      this.#logger.debug(
        {
          code: current ? "skill_sync_update" : "skill_sync_install",
          skill: entry.name,
          ms: this.#now() - started,
        },
        "Skill synchronized",
      );
    }
    for (const [name, managed] of existing) {
      if (desired.has(name)) continue;
      await this.#removeDeparted(input, name, managed);
    }
    return this.#existingSkillPaths(layout);
  }

  async #removeDeparted(input: SkillSyncAgentInput, name: string, managed: ManagedDirectory): Promise<void> {
    const outcome = await this.#retireManaged(input, name, managed);
    this.#logger.debug(
      { code: "skill_sync_remove", skill: name, outcome },
      outcome === "quarantined"
        ? "Skill is no longer enabled; locally edited copy quarantined"
        : "Skill is no longer enabled; removed",
    );
  }

  /**
   * Retire a managed directory, whether it is being replaced or removed.
   *
   * The edited-check lives in one place so the update and removal paths cannot drift apart: a
   * locally edited copy is always quarantined into `.opentag/skill-conflicts/`, never silently
   * destroyed. An unedited copy is removed.
   */
  async #retireManaged(
    input: SkillSyncAgentInput,
    name: string,
    current: ManagedDirectory,
  ): Promise<"quarantined" | "removed"> {
    const recorded = await readContentDigest(current.path);
    const live = await hashSkillDirectory(current.path).catch(() => undefined);
    const edited = recorded !== undefined && live !== undefined && recorded !== live;
    if (edited) {
      await quarantineConflict(input.cwd, name, current.path, this.#now(), this.#logger);
      return "quarantined";
    }
    await rm(current.path, { recursive: true, force: true });
    return "removed";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
