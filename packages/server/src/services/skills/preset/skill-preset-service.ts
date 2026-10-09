import {
  type InstallSkillPresetResponse,
  InstallSkillPresetResponseSchema,
  type ListSkillPresetsResponse,
  ListSkillPresetsResponseSchema,
  SKILL_ERROR_CODES,
  type Skill,
  type SkillDetail,
  type SkillPresetState,
} from "@opentag/shared";
import {
  type PresetSkill,
  type PresetSkillCategory,
  SKILL_PRESET_CATEGORIES,
  SKILL_PRESETS,
} from "@opentag/skill-presets";
import type { ServiceLogger } from "../../../observability/service-logger.js";
import { SkillServiceError, skillNameConflict, skillPresetNotFound } from "../errors.js";
import { normalizeSkillArchive } from "../skill-archive.js";
import type { SkillRowExpectation, SkillService } from "../skill-service.js";

/**
 * Preset Skill discovery and installation.
 *
 * The catalog is repo-shipped data (`@opentag/skill-presets`); this service only computes how it
 * relates to one Agent and installs through `SkillService.upload`, so archive validation, the
 * name rules, the per-Agent limit, revision concurrency, and storage failures stay in one place.
 * Ownership is established by the same `SkillService` reads the rest of the surface uses, which is
 * why an Agent from another Account is indistinguishable from a missing one here too.
 *
 * Each packaged archive is normalized once through the same `normalizeSkillArchive` an upload runs
 * before it is served or compared. The generator packs bundles with the Client packer, whose bytes
 * differ from the Server's canonical repack (compression level, directory entries), so comparing
 * the generated sha would report every freshly installed preset as `update_available`. The served
 * `archiveSha256` is therefore the canonical stored one.
 *
 * State is computed per request from the Agent's current rows. `update_available` requires
 * `source === "preset"`, so the catalog can never offer to overwrite a Skill a user uploaded: a
 * same-named Skill from another source is a `name_conflict` and install refuses it.
 */

export interface SkillPresetServiceOptions {
  skills: SkillService;
  /** The catalog; defaults to the packaged one, and is injectable so tests can pin its content. */
  presets?: readonly PresetSkill[];
  categories?: readonly PresetSkillCategory[];
  logger?: ServiceLogger;
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function stateFor(preset: PresetSkill, existing: Skill | undefined): SkillPresetState {
  if (existing === undefined) return "not_installed";
  if (existing.archiveSha256 === preset.archiveSha256) return "installed";
  return existing.source === "preset" ? "update_available" : "name_conflict";
}

/** Whether the failure is a lost write race rather than a real refusal: re-reading can settle it. */
function isConcurrencyLoss(error: unknown): boolean {
  return (
    error instanceof SkillServiceError &&
    (error.code === SKILL_ERROR_CODES.NAME_CONFLICT || error.code === SKILL_ERROR_CODES.REVISION_CONFLICT)
  );
}

/**
 * The row an install may replace: the one it just read, so the write loses the race against anything
 * that moved the row instead of overwriting it. `undefined` when the read found no row to replace.
 */
function expectedRowFor(existing: Skill | undefined): SkillRowExpectation | undefined {
  if (existing === undefined) return undefined;
  return { id: existing.id, revision: existing.revision, source: existing.source };
}

/** The `SkillSchema` fields of a row, without the detail-only file listing. */
function skillSummary(skill: Skill | SkillDetail): Skill {
  return {
    id: skill.id,
    agentId: skill.agentId,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    source: skill.source,
    archiveSha256: skill.archiveSha256,
    archiveBytes: skill.archiveBytes,
    fileCount: skill.fileCount,
    revision: skill.revision,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

export class SkillPresetService {
  readonly #skills: SkillService;
  readonly #presets: readonly PresetSkill[];
  readonly #categories: readonly PresetSkillCategory[];
  readonly #logger: ServiceLogger | undefined;
  #canonical: Promise<readonly PresetSkill[]> | undefined;

  constructor(options: SkillPresetServiceOptions) {
    this.#skills = options.skills;
    this.#presets = options.presets ?? SKILL_PRESETS;
    this.#categories = options.categories ?? SKILL_PRESET_CATEGORIES;
    this.#logger = options.logger;
  }

  // ------------------------------------------------------------------ account

  async list(callerUserId: string, agentId: string): Promise<ListSkillPresetsResponse> {
    const { skills } = await this.#skills.list(callerUserId, agentId);
    return this.#catalogFor(skills);
  }

  async install(callerUserId: string, agentId: string, presetName: string): Promise<InstallSkillPresetResponse> {
    return this.#install(
      {
        load: () => this.#skills.list(callerUserId, agentId).then((response) => response.skills),
        save: (preset, replace, expectedRow) =>
          this.#skills.upload(callerUserId, agentId, {
            bytes: preset.archive,
            format: "tar.gz",
            declaredSha256: preset.archiveSha256,
            replace,
            ...(expectedRow ? { expectedRow } : {}),
            source: "preset",
          }),
      },
      presetName,
    );
  }

  // --------------------------------------------------------------- agent (cli)

  async listForAgent(agentId: string): Promise<ListSkillPresetsResponse> {
    const { skills } = await this.#skills.listForAgent(agentId);
    return this.#catalogFor(skills);
  }

  async installForAgent(agentId: string, presetName: string): Promise<InstallSkillPresetResponse> {
    return this.#install(
      {
        load: () => this.#skills.listForAgent(agentId).then((response) => response.skills),
        save: (preset, replace, expectedRow) =>
          this.#skills.uploadForAgent(
            agentId,
            {
              bytes: preset.archive,
              format: "tar.gz",
              declaredSha256: preset.archiveSha256,
              replace,
              ...(expectedRow ? { expectedRow } : {}),
            },
            "preset",
          ),
      },
      presetName,
    );
  }

  // ------------------------------------------------------------------- shared

  /** The catalog as the Server stores it: one normalization per preset, memoized for the process. */
  #canonicalPresets(): Promise<readonly PresetSkill[]> {
    this.#canonical ??= Promise.all(
      this.#presets.map(async (preset) => {
        const normalized = await normalizeSkillArchive(preset.archive, "tar.gz");
        return {
          ...preset,
          archive: normalized.archive,
          archiveSha256: normalized.sha256,
          archiveBytes: normalized.archive.byteLength,
          fileCount: normalized.fileCount,
        };
      }),
    );
    return this.#canonical;
  }

  async #catalogFor(skills: readonly Skill[]): Promise<ListSkillPresetsResponse> {
    const presets = await this.#canonicalPresets();
    return ListSkillPresetsResponseSchema.parse({
      categories: this.#categories.map((category) => ({ id: category.id, order: category.order })),
      presets: presets.map((preset) => ({
        name: preset.name,
        description: preset.description,
        category: preset.category,
        order: preset.order,
        archiveSha256: preset.archiveSha256,
        archiveBytes: preset.archiveBytes,
        fileCount: preset.fileCount,
        state: stateFor(
          preset,
          skills.find((skill) => sameName(skill.name, preset.name)),
        ),
      })),
    });
  }

  /**
   * Install or update one preset, converging a lost race once.
   *
   * Two installs of the same preset can interleave: one inserts, the other meets the unique name or
   * a moved revision. Re-reading settles that case — the row now either matches the preset (report
   * `unchanged`) or is the outdated `preset` row the second caller meant to update — and a second
   * loss is rethrown rather than retried forever.
   *
   * `replace` is decided from this loop's read, so the write carries that same row as its expectation:
   * a user upload landing in between makes the write lose the race instead of overwriting it, and the
   * re-read then classifies the row by its new provenance (`name_conflict` for a user's own Skill).
   */
  async #install(
    input: {
      load: () => Promise<readonly Skill[]>;
      save: (
        preset: PresetSkill,
        replace: boolean,
        expectedRow: SkillRowExpectation | undefined,
      ) => Promise<SkillDetail>;
    },
    presetName: string,
  ): Promise<InstallSkillPresetResponse> {
    const presets = await this.#canonicalPresets();
    const preset = presets.find((candidate) => candidate.name === presetName);
    if (preset === undefined) throw skillPresetNotFound();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = (await input.load()).find((skill) => sameName(skill.name, preset.name));
      const state = stateFor(preset, existing);
      if (state === "installed" && existing !== undefined) {
        return InstallSkillPresetResponseSchema.parse({ action: "unchanged", skill: skillSummary(existing) });
      }
      if (state === "name_conflict") throw skillNameConflict();
      try {
        const detail = await input.save(preset, state === "update_available", expectedRowFor(existing));
        const action = state === "not_installed" ? "installed" : "updated";
        this.#logger?.info({ agentId: detail.agentId, action, name: detail.name }, "Preset Skill installed");
        return InstallSkillPresetResponseSchema.parse({ action, skill: skillSummary(detail) });
      } catch (error) {
        if (attempt === 1 || !isConcurrencyLoss(error)) throw error;
        this.#logger?.debug({ name: preset.name }, "Preset Skill install lost a race; re-reading");
      }
    }
    throw new Error("The preset Skill install did not converge");
  }
}
