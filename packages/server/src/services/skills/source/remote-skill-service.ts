import {
  InstallRemoteSkillsResponseSchema,
  parseSkillSource,
  type RemoteSkillInstallResult,
  type RemoteSkillSelection,
  type RemoteSkillSource,
  type RemoteSkillUnavailableReason,
  ResolveRemoteSkillsResponseSchema,
  SKILL_ERROR_CODES,
  type SkillErrorCode,
} from "@opentag/shared";
import type { ServiceLogger } from "../../../observability/service-logger.js";
import { SkillServiceError, skillSourceInvalid, skillSourceNoSkills } from "../errors.js";
import { normalizeSkillEntries } from "../skill-archive.js";
import type { SkillReadLimits } from "../skill-archive-reader.js";
import type { SkillService } from "../skill-service.js";
import { openDocumentSource } from "./document-source.js";
import { assertGitRemoteAllowed, fetchGitSnapshot, type GitProcessRunner } from "./git-source.js";
import {
  discoverRemoteSkills,
  type MaterializedSkillFile,
  type RemoteSkillListing,
  skillArchiveEntries,
} from "./remote-candidates.js";
import { SkillSourceFetcher } from "./source-fetcher.js";
import { SkillSourceTunnel } from "./source-tunnel.js";
import { SkillSourceWorkspace } from "./source-workspace.js";
import { resolveWellKnownSource } from "./well-known-source.js";

/**
 * Remote Skill installation: read a source, show what it holds, install a selection.
 *
 * Every operation is scoped to one Agent, and the Agent's ownership is established by the same
 * `SkillService` reads and writes the rest of the surface uses — so an Agent belonging to another
 * Account is indistinguishable from a missing one here too. Writes go through
 * `SkillService.upload`, which is what keeps the archive contract, the name rules, the per-Agent
 * limit, and the revision semantics in exactly one place: this service decides *what* to install,
 * never *how* a Skill is stored.
 *
 * A preview and an install each read the source again. The alternative — holding a fetched snapshot
 * between the two calls — would need a server-side cache with expiry and would assume a caller
 * always returns to the same instance, while re-reading costs a tree listing and, at most, one
 * bounded artifact download. What the user previewed can therefore have moved: the per-item result
 * reports a Skill that vanished, a name that now exists, or content that no longer packages, and it
 * never installs something other than what was selected.
 */

export interface RemoteSkillServiceOptions {
  skills: SkillService;
  /** Injectable for tests; the default enforces the shared address rules. */
  fetcher?: SkillSourceFetcher;
  gitRunner?: GitProcessRunner;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  /** Only for a local-development deployment, exactly as the MCP gate has it. */
  allowLoopback?: boolean;
  maxCandidates?: number;
  readLimits?: SkillReadLimits;
  logger?: ServiceLogger;
}

export interface ResolveRemoteSkillsInput {
  callerUserId: string;
  agentId: string;
  source: string;
  signal?: AbortSignal;
}

export interface InstallRemoteSkillsInput extends ResolveRemoteSkillsInput {
  selections: readonly RemoteSkillSelection[];
}

/** A source that was read, plus the cleanup that has to run when the request ends. */
interface OpenedSource {
  source: RemoteSkillSource;
  listings: RemoteSkillListing[];
  dispose: () => Promise<void>;
}

const REPOSITORY_KINDS: readonly RemoteSkillSource["kind"][] = ["github", "gitlab", "azure", "git"];

function isRepository(kind: RemoteSkillSource["kind"]): boolean {
  return REPOSITORY_KINDS.includes(kind);
}

/** The error code a candidate that can never be packaged reports. */
function unavailableCode(reason: RemoteSkillUnavailableReason): SkillErrorCode {
  switch (reason) {
    case "manifest_invalid":
      return SKILL_ERROR_CODES.MANIFEST_INVALID;
    case "name_reserved":
      return SKILL_ERROR_CODES.NAME_RESERVED;
    case "too_large":
      return SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE;
    case "path_invalid":
      // Packaging would raise this too, because the canonical member rules are what reject the path.
      return SKILL_ERROR_CODES.ARCHIVE_INVALID;
  }
}

export class RemoteSkillService {
  readonly #skills: SkillService;
  readonly #fetcher: SkillSourceFetcher;
  readonly #gitRunner: GitProcessRunner | undefined;
  readonly #logger: ServiceLogger | undefined;
  readonly #maxCandidates: number | undefined;
  readonly #readLimits: SkillReadLimits | undefined;
  readonly #remoteOptions: { allowLoopback: boolean; resolveAddresses?: (hostname: string) => Promise<string[]> };

  constructor(options: RemoteSkillServiceOptions) {
    this.#skills = options.skills;
    this.#fetcher =
      options.fetcher ??
      new SkillSourceFetcher({
        allowLoopback: options.allowLoopback === true,
        ...(options.resolveAddresses === undefined ? {} : { resolveAddresses: options.resolveAddresses }),
      });
    this.#gitRunner = options.gitRunner;
    this.#logger = options.logger;
    this.#maxCandidates = options.maxCandidates;
    this.#readLimits = options.readLimits;
    this.#remoteOptions = {
      allowLoopback: options.allowLoopback === true,
      ...(options.resolveAddresses === undefined ? {} : { resolveAddresses: options.resolveAddresses }),
    };
  }

  /** The Skills a source holds, with the two facts the user needs: what each is, and what exists. */
  async resolve(input: ResolveRemoteSkillsInput): Promise<ReturnType<typeof ResolveRemoteSkillsResponseSchema.parse>> {
    const opened = await this.#open(input);
    try {
      if (opened.listings.length === 0) throw skillSourceNoSkills();
      this.#logger?.debug(
        { agentId: input.agentId, kind: opened.source.kind, candidates: opened.listings.length },
        "Remote Skill source resolved",
      );
      return ResolveRemoteSkillsResponseSchema.parse({
        source: opened.source,
        skills: opened.listings.map((listing) => listing.candidate),
      });
    } finally {
      await opened.dispose();
    }
  }

  /**
   * Installs the selected Skills, one by one. Each selection names a Skill *and* the fingerprint the
   * preview reported, so an item whose source changed in between fails instead of installing bytes
   * the user never saw. A name that appears twice is installed once and reported as skipped the
   * second time; a name that is not in the source, or that cannot be packaged, fails on its own
   * without touching the others.
   */
  async install(input: InstallRemoteSkillsInput): Promise<ReturnType<typeof InstallRemoteSkillsResponseSchema.parse>> {
    const opened = await this.#open(input);
    try {
      const byName = new Map(opened.listings.map((listing) => [listing.candidate.name.toLowerCase(), listing]));
      const handled = new Set<string>();
      const results: RemoteSkillInstallResult[] = [];
      for (const selection of input.selections) {
        const name = selection.name.trim();
        const key = name.toLowerCase();
        const listing = byName.get(key);
        if (listing === undefined) {
          results.push({ name, status: "failed", errorCode: SKILL_ERROR_CODES.NOT_FOUND });
          continue;
        }
        if (handled.has(key)) {
          results.push({ name, status: "skipped_name_conflict" });
          continue;
        }
        handled.add(key);
        results.push(await this.#installOne(input, listing, selection));
      }
      this.#logger?.info(
        {
          agentId: input.agentId,
          kind: opened.source.kind,
          selected: results.length,
          installed: results.filter((result) => result.status === "installed").length,
          skipped: results.filter((result) => result.status === "skipped_name_conflict").length,
          failed: results.filter((result) => result.status === "failed").length,
        },
        "Remote Skill install finished",
      );
      return InstallRemoteSkillsResponseSchema.parse({ results });
    } finally {
      await opened.dispose();
    }
  }

  async #installOne(
    input: ResolveRemoteSkillsInput,
    listing: RemoteSkillListing,
    selection: RemoteSkillSelection,
  ): Promise<RemoteSkillInstallResult> {
    const name = listing.candidate.name;
    const reason = listing.candidate.unavailableReason;
    if (reason !== undefined) {
      return { name, status: "failed", errorCode: unavailableCode(reason) };
    }
    try {
      /*
       * The preview's fingerprint is compared against the source as it reads now. A branch, an index,
       * or an artifact that moved between the two calls is reported as a revision conflict — the code
       * that already means "this changed while you were working" — rather than installed quietly.
       */
      if ((await listing.fingerprint()) !== selection.fingerprint) {
        this.#logger?.debug(
          { agentId: input.agentId, name, code: SKILL_ERROR_CODES.REVISION_CONFLICT },
          "Remote Skill changed since the preview",
        );
        return { name, status: "failed", errorCode: SKILL_ERROR_CODES.REVISION_CONFLICT };
      }
      const files = await listing.materialize();
      const normalized = await normalizeSkillEntries(skillArchiveEntries(files), this.#readLimits);
      // The selection is by name, so a source whose content claims another name would install
      // something the user did not choose. A well-known index publishes its own metadata, which is
      // exactly where the two can disagree.
      if (normalized.manifest.name.toLowerCase() !== name.toLowerCase()) {
        return { name, status: "failed", errorCode: SKILL_ERROR_CODES.MANIFEST_INVALID };
      }
      await this.#skills.upload(input.callerUserId, input.agentId, {
        bytes: normalized.archive,
        format: "tar.gz",
        declaredSha256: normalized.sha256,
        replace: false,
        source: "url_install",
      });
      this.#logger?.debug({ agentId: input.agentId, name, status: "installed" }, "Remote Skill installed");
      return { name, status: "installed" };
    } catch (error) {
      if (error instanceof SkillServiceError) {
        const status = error.code === SKILL_ERROR_CODES.NAME_CONFLICT ? "skipped_name_conflict" : "failed";
        this.#logger?.debug(
          { agentId: input.agentId, name, status, code: error.code },
          "Remote Skill install item finished",
        );
        return status === "skipped_name_conflict" ? { name, status } : { name, status, errorCode: error.code };
      }
      throw error;
    }
  }

  /**
   * Normalizes and reads a source. The workspace is created only for a repository, and is removed on
   * every path: a fetched tree is the one thing here that has to be cleaned up.
   */
  async #open(input: ResolveRemoteSkillsInput): Promise<OpenedSource> {
    const parsed = parseSkillSource(input.source);
    if (!parsed.ok) {
      this.#logger?.debug({ agentId: input.agentId, rejection: parsed.rejection }, "Remote Skill source refused");
      throw skillSourceInvalid();
    }
    const source = parsed.source;
    const existingNames = (await this.#skills.list(input.callerUserId, input.agentId)).skills.map(
      (skill) => skill.name,
    );
    if (isRepository(source.kind)) return this.#openRepository(source, existingNames, input.signal);
    if (source.kind === "well_known") return this.#openWellKnown(source, existingNames);
    const document = await openDocumentSource(this.#fetcher, source.url);
    return {
      source,
      listings: await this.#discover(document.snapshot, source, existingNames),
      dispose: document.snapshot.dispose,
    };
  }

  async #openRepository(
    source: RemoteSkillSource,
    existingNames: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<OpenedSource> {
    /*
     * Git resolves hostnames itself, so the address rules are bound to its connections by routing
     * them through a loopback tunnel that resolves, judges, and then dials. Every connection git
     * makes for this source — the clone, the tree listing, and each lazy blob fetch — goes through it,
     * so a name cannot resolve publicly for the check and privately for the connection.
     */
    await assertGitRemoteAllowed(source, this.#remoteOptions);
    const tunnel = await SkillSourceTunnel.start(this.#remoteOptions);
    const workspace = await SkillSourceWorkspace.create();
    try {
      const snapshot = await fetchGitSnapshot({
        source,
        workspace: workspace.root,
        signal: signal ?? new AbortController().signal,
        proxyUrl: tunnel.proxyUrl,
        ...(this.#gitRunner === undefined ? {} : { run: this.#gitRunner }),
      });
      return {
        source,
        listings: await this.#discover(snapshot, source, existingNames),
        dispose: async () => {
          await snapshot.dispose();
          await workspace.dispose();
          await tunnel.close();
        },
      };
    } catch (error) {
      await workspace.dispose();
      await tunnel.close();
      throw error;
    }
  }

  /** A host that publishes no index at all is read as a direct download, exactly as the ecosystem does. */
  async #openWellKnown(source: RemoteSkillSource, existingNames: readonly string[]): Promise<OpenedSource> {
    const index = await resolveWellKnownSource(this.#fetcher, source.url, existingNames);
    if (index.found) {
      return { source, listings: index.listings, dispose: async () => undefined };
    }
    const document = await openDocumentSource(this.#fetcher, source.url);
    return {
      source,
      listings: await this.#discover(document.snapshot, source, existingNames),
      dispose: document.snapshot.dispose,
    };
  }

  #discover(
    snapshot: Parameters<typeof discoverRemoteSkills>[0]["snapshot"],
    source: RemoteSkillSource,
    existingNames: readonly string[],
  ): Promise<RemoteSkillListing[]> {
    return discoverRemoteSkills({
      snapshot,
      existingNames,
      // `owner/repo@skill` and `#ref@skill` name one Skill: without this the filter would be accepted
      // and ignored, and an install would offer the whole repository.
      ...(source.skillFilter === undefined ? {} : { nameFilter: source.skillFilter }),
      ...(source.subpath === undefined ? {} : { subpath: source.subpath }),
      ...(this.#maxCandidates === undefined ? {} : { maxCandidates: this.#maxCandidates }),
    });
  }
}

export type { MaterializedSkillFile };
