import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type AgentRuntimeProvider,
  type RuntimeSkillManifest,
  SKILL_MARKER_FILE,
  type SkillInstallMarker,
  SkillInstallMarkerSchema,
} from "@opentag/shared";
import type { ClientLogger } from "../observability/logger.js";
import { ensurePrivateDirectory } from "../storage/durable-file.js";
import { SKILL_CONTENT_SIDECAR_FILE } from "./skill-archive.js";
import { verifySkillBundle } from "./skill-bundle.js";
import { readBundleBody } from "./skill-bundle-body.js";
import {
  hashSkillDirectory,
  moveAside,
  SKILL_STAGING_STALE_MS,
  stageBundle,
  sweepStaleStaging,
} from "./skill-install.js";
import {
  isSyncedWorkspace,
  skillConflictsRoot,
  skillRootForProvider,
  skillStagingRoot,
  unsafeSkillRootReason,
} from "./skill-roots.js";

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
  /** Test seam for the final staged-directory rename; defaults to the real `rename`. */
  readonly rename?: typeof rename;
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
export { skillRootForProvider };

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

export { hashSkillDirectory, isSyncedWorkspace };

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
  const bytes = await readBundleBody(response, { signal, maxBytes: entry.archiveBytes });
  return verifySkillBundle(bytes, entry);
}

async function quarantineConflict(
  cwd: string,
  name: string,
  source: string,
  nowMs: number,
  logger: ClientLogger,
): Promise<void> {
  const stamp = new Date(nowMs).toISOString().replaceAll(/[:.]/gu, "-");
  const target = join(skillConflictsRoot(cwd), `${name}-${stamp}`);
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
  readonly #rename: typeof rename;

  constructor(options: SkillSyncManagerOptions) {
    this.#api = options.api;
    this.#machineToken = options.machineToken;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => Date.now());
    this.#budgetMs = options.budgetMs ?? SKILL_SYNC_DEFAULT_BUDGET_MS;
    this.#rename = options.rename ?? rename;
  }

  async ensureAgent(input: SkillSyncAgentInput): Promise<SkillSyncResult> {
    const layout = installLayout(input);
    const unsafe = await unsafeSkillRootReason(input.cwd, [
      layout.root,
      skillStagingRoot(input.cwd),
      skillConflictsRoot(input.cwd),
    ]);
    if (unsafe) {
      this.#logger.warn(
        { code: "skill_root_unsafe", reason: unsafe },
        "Agent Skill root is unsafe; leaving every directory untouched",
      );
      return { skillPaths: [], status: "unavailable" };
    }
    const signal = AbortSignal.timeout(this.#budgetMs);
    const stagingRoot = skillStagingRoot(input.cwd);
    try {
      // The staging root doubles as the workspace sentinel that `skill push` checks before
      // adopting a directory, so it is created on every start, even with nothing to install.
      await ensurePrivateDirectory(dirname(stagingRoot), stagingRoot);
      await sweepStaleStaging(stagingRoot, SKILL_STAGING_STALE_MS, this.#now);
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
      // Download and verify, then stage and validate the whole replacement before the current
      // copy is touched. Only a fully prepared bundle may ever displace what is on disk.
      const bytes = await downloadedBundle(this.#api, token, input.agentId, entry, signal);
      const started = this.#now();
      const staged = await stageBundle(skillStagingRoot(input.cwd), entry, bytes);
      await this.#swapIn(input, layout, current, entry.name, staged);
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

  /**
   * Install a validated staging directory over the current copy.
   *
   * The current copy is moved aside (never deleted) until the rename succeeds, so a failure at the
   * final step restores it. An edited copy is quarantined instead, which already preserves it.
   */
  async #swapIn(
    input: SkillSyncAgentInput,
    layout: SkillInstallLayout,
    current: ManagedDirectory | undefined,
    name: string,
    staged: string,
  ): Promise<void> {
    await ensurePrivateDirectory(dirname(layout.root), layout.root);
    let aside: string | undefined;
    if (current) aside = (await this.#retireManaged(input, name, current, true)).aside;
    const destination = join(layout.root, layout.directoryName(name));
    try {
      await this.#rename(staged, destination);
    } catch (error) {
      if (aside) await rename(aside, destination).catch(() => undefined);
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    if (aside) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }

  async #removeDeparted(input: SkillSyncAgentInput, name: string, managed: ManagedDirectory): Promise<void> {
    const { kind } = await this.#retireManaged(input, name, managed, false);
    this.#logger.debug(
      { code: "skill_sync_remove", skill: name, outcome: kind },
      kind === "quarantined"
        ? "Skill is no longer enabled; locally edited copy quarantined"
        : "Skill is no longer enabled; removed",
    );
  }

  /**
   * Retire a managed directory, whether it is being replaced or removed.
   *
   * The edited-check lives in one place so the update and removal paths cannot drift apart: a
   * locally edited copy is always quarantined into `.opentag/skill-conflicts/`, never silently
   * destroyed. On a replacement an unedited copy is moved aside (returned as `aside`) so it can be
   * restored; a removal deletes it outright.
   */
  async #retireManaged(
    input: SkillSyncAgentInput,
    name: string,
    current: ManagedDirectory,
    keepAside: boolean,
  ): Promise<{ kind: "quarantined" | "removed"; aside?: string }> {
    const recorded = await readContentDigest(current.path);
    const live = await hashSkillDirectory(current.path).catch(() => undefined);
    const edited = recorded !== undefined && live !== undefined && recorded !== live;
    if (edited) {
      await quarantineConflict(input.cwd, name, current.path, this.#now(), this.#logger);
      return { kind: "quarantined" };
    }
    if (keepAside) {
      return { kind: "removed", aside: await moveAside(skillStagingRoot(input.cwd), current.path, randomUUID()) };
    }
    await rm(current.path, { recursive: true, force: true });
    return { kind: "removed" };
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
