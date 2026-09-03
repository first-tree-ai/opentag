import semver from "semver";
import { createLogger } from "../../observability/logger.js";
import { RuntimeStorageError } from "../../storage/durable-file.js";
import {
  type ProviderCliAccountLayout,
  providerCliLauncherPath,
  resolveProviderCliAccountLayout,
} from "./account-layout.js";
import { findCatalogArtifact, type ProviderCliCatalogEntry, requireProviderCliCatalogEntry } from "./catalog.js";
import {
  detectProviderCliCandidates,
  type ProviderCliCandidate,
  type ProviderCliDetection,
  rankProviderCliCandidates,
  verifyProviderCliCandidateFingerprint,
} from "./detector.js";
import { computeFileIdentity, computeTargetFingerprint } from "./fingerprint.js";
import { type ProviderCliFetcher, ProviderCliInstallError, ProviderCliInstaller } from "./installer.js";
import {
  inspectGlobalCommand,
  inspectProviderCliLauncher,
  type ProviderCliGlobalCommandStatus,
  reconcileProviderCliLauncher,
  reconcileProviderCliShim,
} from "./launcher.js";
import { ProviderCliLockBusyError, withProviderCliLock } from "./lock.js";
import { type ProviderCliExecFile, probeProviderCliExecutable } from "./probe.js";
import {
  type ProviderCliSelection,
  type ProviderCliSelectionRecord,
  providerCliSelectionTargetPath,
  readProviderCliSelection,
  writeProviderCliSelection,
} from "./selection-store.js";
import type {
  ProviderCliCandidateReport,
  ProviderCliDiagnostic,
  ProviderCliEnsureResult,
  ProviderCliInspection,
  ProviderCliPhase,
  ProviderCliPhaseRecord,
  ProviderCliProvider,
  ProviderCliWarning,
} from "./types.js";

/**
 * Read-only inspection and the ensure orchestration for one OS-account Provider CLI
 * installation. The manager owns selection validation, probing, readiness mapping, and
 * the ensure transaction; it never forwards paths or diagnostics off the machine.
 */

export interface ProviderCliManagerDeps {
  /** OS account home (from the account record), never OPENTAG_HOME or caller $HOME. */
  readonly accountHome: string;
  /** Invoking CLI process environment; the detection PATH authority. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly catalog?: readonly ProviderCliCatalogEntry[];
  readonly fetcher?: ProviderCliFetcher;
  readonly execFile?: ProviderCliExecFile;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test hook: runs inside the provider lock immediately before winner re-verification. */
  readonly beforeWinnerReverify?: (winner: ProviderCliCandidate) => Promise<void>;
}

export type ProviderCliPhaseEvent = ProviderCliPhaseRecord & { readonly provider: ProviderCliProvider };

export interface ProviderCliEnsureOptions {
  readonly mode?: "auto" | "managed-only";
  /** Create or refresh the public shim in the account's `~/.local/bin`. Default true. */
  readonly pathUpdate?: boolean;
  readonly dryRun?: boolean;
  readonly onPhase?: (event: ProviderCliPhaseEvent) => void;
}

const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux"]);
const logger = createLogger("runtime-provider-cli-manager");

const REMEDIATIONS: Record<string, string> = {
  not_installed: "Run `opentag provider-cli ensure` to select a compatible CLI or install the reviewed artifact.",
  unsupported_platform: "Provider CLI management supports macOS and Linux on arm64/x64 only.",
  selection_invalid: "The selection record is malformed; run `opentag provider-cli ensure` to repair it.",
  external_path_invalid: "The selected executable is missing or unsafe; run `opentag provider-cli ensure` again.",
  artifact_drifted: "The selected executable changed after validation; run `opentag provider-cli ensure` to re-probe.",
  launcher_invalid:
    "The account-global launcher is missing or replaced; run `opentag provider-cli ensure` to repair it.",
  global_bin_unavailable: "Check that the account home is writable and not on a read-only filesystem.",
  version_incompatible:
    "The installed Provider CLI is outside the range this OpenTag version supports; it was left untouched.",
  probe_failed: "The selected executable failed its bounded local probe; reinstall or select another candidate.",
  integrity_failed: "The downloaded artifact failed digest or archive verification; retry or report the mismatch.",
  install_incomplete: "The install did not complete; rerun `opentag provider-cli ensure`.",
  operation_in_progress: "Another OpenTag process is modifying this Provider CLI; retry after it finishes.",
  global_command_shadowed: "Another command resolves first on PATH; OpenTag Runtime uses its own launcher regardless.",
  global_path_not_configured: "Add the OpenTag shim directory to PATH to use the command from your shell.",
  external_candidate_unverified:
    "The selected executable is compatible but its digest is not in the reviewed catalog; provenance is unverified.",
};

function diagnostic(code: ProviderCliDiagnostic["code"]): ProviderCliDiagnostic {
  return { code, remediation: REMEDIATIONS[code] };
}

function warning(code: ProviderCliWarning["code"]): ProviderCliWarning {
  return { code, remediation: REMEDIATIONS[code] };
}

interface EnsureSession {
  readonly phases: ProviderCliPhaseRecord[];
  recordPhase(phase: ProviderCliPhase, status: ProviderCliPhaseRecord["status"], detail?: string): void;
}

export class ProviderCliManager {
  readonly #deps: ProviderCliManagerDeps;
  readonly #layout: ProviderCliAccountLayout;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(deps: ProviderCliManagerDeps) {
    this.#deps = deps;
    this.#platform = deps.platform ?? process.platform;
    this.#arch = deps.arch ?? process.arch;
    this.#env = deps.env ?? process.env;
    this.#layout = resolveProviderCliAccountLayout(deps.accountHome, this.#platform);
  }

  get layout(): ProviderCliAccountLayout {
    return this.#layout;
  }

  #entry(provider: ProviderCliProvider): ProviderCliCatalogEntry {
    return requireProviderCliCatalogEntry(provider, this.#deps.catalog);
  }

  #globalCommandWarnings(globalCommand: ProviderCliGlobalCommandStatus, hasSelection: boolean): ProviderCliWarning[] {
    const warnings: ProviderCliWarning[] = [];
    if (globalCommand.shadowed) {
      warnings.push(warning("global_command_shadowed"));
    } else if (hasSelection && !globalCommand.active) {
      warnings.push(warning("global_path_not_configured"));
    }
    return warnings;
  }

  /** Read-only selection validation, launcher check, fingerprint verify, and probe. */
  async inspect(provider: ProviderCliProvider): Promise<ProviderCliInspection> {
    const entry = this.#entry(provider);
    const launcherPath = providerCliLauncherPath(this.#layout, entry.command);
    const globalCommand = await inspectGlobalCommand(this.#layout, entry.command, this.#env);

    if (!SUPPORTED_PLATFORMS.has(this.#platform)) {
      return {
        provider,
        state: "unavailable",
        readiness: "unavailable",
        launcher: { path: launcherPath, status: "missing" },
        globalCommand,
        warnings: [],
        diagnostic: diagnostic("unsupported_platform"),
      };
    }

    let record: ProviderCliSelectionRecord | undefined;
    try {
      record = await readProviderCliSelection(this.#layout, provider);
    } catch (error) {
      logger.debug(
        { code: "selection_inspection_failed", provider, error: String(error) },
        "Provider CLI selection inspection failed",
      );
      const launcher = await inspectProviderCliLauncher(this.#layout, entry, undefined);
      return {
        provider,
        state: "unavailable",
        readiness: "unavailable",
        launcher: { path: launcher.path, status: launcher.status },
        globalCommand,
        warnings: [],
        diagnostic: diagnostic("selection_invalid"),
      };
    }

    if (!record) {
      const launcher = await inspectProviderCliLauncher(this.#layout, entry, undefined);
      return {
        provider,
        state: "absent",
        readiness: "install",
        launcher: { path: launcher.path, status: launcher.status },
        globalCommand,
        warnings: this.#globalCommandWarnings(globalCommand, false),
        diagnostic: diagnostic("not_installed"),
      };
    }

    const selection = record.selection;
    const targetPath = providerCliSelectionTargetPath(selection);
    const summary = {
      kind: selection.kind,
      path: targetPath,
      version: selection.version,
      trust: selection.kind === "managed" ? ("catalog-verified" as const) : selection.trust,
      generation: record.generation,
    };
    const warnings = this.#globalCommandWarnings(globalCommand, true);
    if (selection.kind === "external" && selection.trust === "compatible-unverified") {
      warnings.push(warning("external_candidate_unverified"));
    }

    const fail = async (code: ProviderCliDiagnostic["code"]): Promise<ProviderCliInspection> => {
      const launcher = await inspectProviderCliLauncher(this.#layout, entry, selection);
      return {
        provider,
        state: "unavailable",
        readiness: "unavailable",
        selection: summary,
        launcher: { path: launcher.path, status: launcher.status },
        globalCommand,
        warnings,
        diagnostic: diagnostic(code),
      };
    };

    // Validate the exact selected target and its fingerprint.
    const identity = await computeFileIdentity(targetPath).catch((error: unknown) => {
      logger.debug(
        { code: "selection_identity_failed", provider, error: String(error) },
        "Provider CLI selection identity failed",
      );
      return undefined;
    });
    if (!identity) {
      return fail(selection.kind === "external" ? "external_path_invalid" : "artifact_drifted");
    }
    const managedDigest = selection.kind === "managed" ? selection.artifactId.split("/").at(-1) : undefined;
    const fingerprint = computeTargetFingerprint(identity, selection.version, managedDigest);
    if (fingerprint !== selection.fingerprint) {
      return fail("artifact_drifted");
    }

    // The account-global launcher must be ours and target the selection.
    const launcher = await inspectProviderCliLauncher(this.#layout, entry, selection);
    if (launcher.status !== "valid") {
      return fail("launcher_invalid");
    }

    // Probe through the launcher, exactly as Runtime will execute.
    const probed = await probeProviderCliExecutable(launcher.path, entry, {
      ...(this.#deps.execFile ? { execFile: this.#deps.execFile } : {}),
      includeManagedArguments: selection.kind !== "managed",
    });
    if (probed.status === "failed") {
      return fail(probed.code === "probe_failed" ? "probe_failed" : "version_incompatible");
    }

    return {
      provider,
      state: "ready",
      readiness: "ready",
      selection: summary,
      fingerprint,
      launcher: { path: launcher.path, status: "valid" },
      globalCommand,
      warnings,
    };
  }

  /**
   * Select the newest compatible candidate or immediately perform the managed install
   * when no eligible candidate exists. `auto` never skips an eligible external
   * candidate in favor of a managed install within the same operation.
   */
  async ensure(
    provider: ProviderCliProvider,
    options: ProviderCliEnsureOptions = {},
  ): Promise<ProviderCliEnsureResult> {
    const phases: ProviderCliPhaseRecord[] = [];
    const session: EnsureSession = {
      phases,
      recordPhase: (phase, status, detail) => {
        const record: ProviderCliPhaseRecord = detail === undefined ? { phase, status } : { phase, status, detail };
        phases.push(record);
        options.onPhase?.({ provider, ...record });
      },
    };
    const dryRunFields = options.dryRun ? { dryRun: true } : {};
    const failed = (
      code: ProviderCliDiagnostic["code"],
      candidates: ProviderCliCandidateReport[],
    ): ProviderCliEnsureResult => ({
      ok: false,
      provider,
      action: "failed",
      phases,
      candidates,
      readiness: "unavailable",
      globalCommand: { active: false },
      warnings: [],
      diagnostic: diagnostic(code),
      ...dryRunFields,
    });

    if (!SUPPORTED_PLATFORMS.has(this.#platform)) {
      return failed("unsupported_platform", []);
    }

    const entry = this.#entry(provider);
    const mode = options.mode ?? "auto";
    const pathUpdate = options.pathUpdate ?? true;

    session.recordPhase("detect", "started");
    let selection: ProviderCliSelectionRecord | undefined;
    let detection: ProviderCliDetection;
    try {
      selection = await readProviderCliSelection(this.#layout, provider);
      detection = await this.#detect(provider, entry, selection, mode);
    } catch (error) {
      logger.debug({ code: "detection_failed", provider, error: String(error) }, "Provider CLI detection failed");
      session.recordPhase("detect", "failed", "selection_invalid");
      return failed("selection_invalid", []);
    }
    session.recordPhase(
      "detect",
      "completed",
      `${detection.candidates.length} eligible candidate(s), ${detection.ignored.length} ignored`,
    );

    if (options.dryRun) {
      return await this.#dryRunResult(provider, entry, selection, detection, session);
    }

    try {
      return await withProviderCliLock(
        this.#layout,
        provider,
        async () => {
          // Re-read and re-detect inside the lock so the incumbent is consistent.
          const lockedSelection = await readProviderCliSelection(this.#layout, provider);
          const lockedDetection = await this.#detect(provider, entry, lockedSelection, mode);
          return await this.#ensureLocked(provider, entry, lockedSelection, lockedDetection, pathUpdate, session);
        },
        {
          ...(this.#deps.isProcessAlive ? { isProcessAlive: this.#deps.isProcessAlive } : {}),
          ...(this.#deps.sleep ? { sleep: this.#deps.sleep } : {}),
        },
      );
    } catch (error) {
      logger.debug({ code: "ensure_failed", provider, error: String(error) }, "Provider CLI ensure failed");
      if (error instanceof ProviderCliLockBusyError) {
        return failed("operation_in_progress", []);
      }
      if (error instanceof ProviderCliInstallError) {
        return failed(error.code, []);
      }
      if (error instanceof RuntimeStorageError && error.code === "invalid") {
        return failed("selection_invalid", []);
      }
      if (isStorageOrPermissionError(error)) {
        return failed("global_bin_unavailable", []);
      }
      return failed("install_incomplete", []);
    }
  }

  async #detect(
    provider: ProviderCliProvider,
    entry: ProviderCliCatalogEntry,
    selection: ProviderCliSelectionRecord | undefined,
    mode: "auto" | "managed-only",
  ): Promise<ProviderCliDetection> {
    return detectProviderCliCandidates({
      provider,
      entry,
      layout: this.#layout,
      env: this.#env,
      platform: this.#platform,
      arch: this.#arch,
      selection,
      mode,
      ...(this.#deps.execFile ? { execFile: this.#deps.execFile } : {}),
    });
  }

  async #dryRunResult(
    provider: ProviderCliProvider,
    entry: ProviderCliCatalogEntry,
    selection: ProviderCliSelectionRecord | undefined,
    detection: ProviderCliDetection,
    session: EnsureSession,
  ): Promise<ProviderCliEnsureResult> {
    const ranked = rankProviderCliCandidates(detection.candidates);
    const upgradeManaged = shouldInstallManagedUpgrade(selection, entry, ranked.ordered);
    const ordered = upgradeManaged
      ? ranked.ordered.filter((candidate) => !(candidate.kind === "managed" && candidate.incumbent))
      : ranked.ordered;
    const reranked = upgradeManaged ? rankProviderCliCandidates(ordered) : ranked;
    const winner = reranked.ordered[0];
    const candidates = buildCandidateReports(detection, reranked.ordered, winner, reranked.reasons, [
      ...(upgradeManaged && selection
        ? [
            {
              path: providerCliSelectionTargetPath(selection.selection),
              sourceDir: "selection",
              version: selection.selection.version,
              reason: "older-managed-version",
            },
          ]
        : []),
    ]);
    const globalStatus = await inspectGlobalCommand(this.#layout, entry.command, this.#env);
    const globalWarnings = this.#globalCommandWarnings(globalStatus, selection !== undefined);
    const globalCommand = {
      active: globalStatus.active,
      ...(globalStatus.path ? { path: globalStatus.path } : {}),
      ...(globalStatus.resolvedPath ? { resolvedPath: globalStatus.resolvedPath } : {}),
    };
    const base = { provider, candidates, globalCommand, dryRun: true } as const;

    if (winner) {
      const unchanged = isUnchangedIncumbent(selection, winner);
      const action = unchanged || winner.kind === "managed" ? "noop" : "selected-existing";
      session.recordPhase(
        "select",
        "completed",
        unchanged
          ? "dry-run: the current selection is already the best candidate"
          : `dry-run: would select ${winner.version} ${winner.kind} ${winner.path}`,
      );
      return {
        ...base,
        ok: true,
        action,
        phases: session.phases,
        selected: {
          path: winner.path,
          version: winner.version,
          source: winner.kind === "managed" ? "managed" : winner.sourceDir,
          trust: winner.trust,
        },
        readiness: "ready",
        warnings: [
          ...globalWarnings,
          ...(winner.trust === "compatible-unverified" ? [warning("external_candidate_unverified")] : []),
        ],
      };
    }
    if (incompatibleManagedIncumbent(selection, entry, detection)) {
      session.recordPhase("managed-install", "failed", "dry-run: blocked by an incompatible managed installation");
      return {
        ...base,
        ok: false,
        action: "failed",
        phases: session.phases,
        readiness: "unavailable",
        warnings: globalWarnings,
        diagnostic: diagnostic("version_incompatible"),
      };
    }
    if (!findCatalogArtifact(entry, this.#platform, this.#arch)) {
      session.recordPhase("managed-install", "failed", "dry-run: no reviewed artifact for this platform");
      return {
        ...base,
        ok: false,
        action: "failed",
        phases: session.phases,
        readiness: "unavailable",
        warnings: globalWarnings,
        diagnostic: diagnostic("unsupported_platform"),
      };
    }
    session.recordPhase("managed-install", "completed", `dry-run: would install managed ${entry.version}`);
    return {
      ...base,
      ok: true,
      action: "installed-managed",
      phases: session.phases,
      readiness: "ready",
      warnings: globalWarnings,
    };
  }

  async #ensureLocked(
    provider: ProviderCliProvider,
    entry: ProviderCliCatalogEntry,
    selection: ProviderCliSelectionRecord | undefined,
    detection: ProviderCliDetection,
    pathUpdate: boolean,
    session: EnsureSession,
  ): Promise<ProviderCliEnsureResult> {
    let ranked = rankProviderCliCandidates(detection.candidates);
    let winner = ranked.ordered[0];
    const extraIgnored: { path: string; sourceDir?: string; version?: string; reason: string }[] = [];

    // Re-verify each winner immediately before persistence; a changed candidate is
    // removed and the ranking runs again until one verifies or none remain.
    while (winner && !isUnchangedIncumbent(selection, winner)) {
      if (winner.kind === "managed") {
        // A managed incumbent whose fingerprint moved drifted on disk; repair by install.
        extraIgnored.push({ path: winner.path, sourceDir: "selection", reason: "artifact-drifted" });
        ranked = rankProviderCliCandidates(ranked.ordered.slice(1));
        winner = ranked.ordered[0];
        continue;
      }
      await this.#deps.beforeWinnerReverify?.(winner);
      if (await verifyProviderCliCandidateFingerprint(winner)) break;
      extraIgnored.push({ path: winner.path, sourceDir: winner.sourceDir, reason: "external-candidate-changed" });
      ranked = rankProviderCliCandidates(ranked.ordered.slice(1));
      winner = ranked.ordered[0];
    }

    if (shouldInstallManagedUpgrade(selection, entry, ranked.ordered)) {
      const incumbent = ranked.ordered.find((candidate) => candidate.kind === "managed" && candidate.incumbent);
      if (incumbent) {
        extraIgnored.push({
          path: incumbent.path,
          sourceDir: "selection",
          version: incumbent.version,
          reason: "older-managed-version",
        });
        ranked = rankProviderCliCandidates(ranked.ordered.filter((candidate) => candidate.id !== incumbent.id));
        winner = ranked.ordered[0];
      }
    }

    const finalize = (
      partial: Omit<ProviderCliEnsureResult, "provider" | "phases" | "candidates">,
    ): ProviderCliEnsureResult => ({
      provider,
      phases: session.phases,
      candidates: buildCandidateReports(detection, ranked.ordered, winner, ranked.reasons, extraIgnored),
      ...partial,
    });

    let action: ProviderCliEnsureResult["action"];
    let newSelection: ProviderCliSelection | undefined;

    if (winner && isUnchangedIncumbent(selection, winner)) {
      action = "noop";
    } else if (winner) {
      session.recordPhase("select", "started");
      newSelection = {
        kind: "external",
        executablePath: winner.path,
        fingerprint: winner.fingerprint,
        trust: winner.trust,
        version: winner.version,
      };
      action = "selected-existing";
    } else {
      if (
        incompatibleManagedIncumbent(selection, entry, {
          candidates: [],
          ignored: [...detection.ignored, ...extraIgnored],
        })
      ) {
        session.recordPhase("managed-install", "failed", "version_incompatible");
        return finalize({
          ok: false,
          action: "failed",
          readiness: "unavailable",
          globalCommand: { active: false },
          warnings: [],
          diagnostic: diagnostic("version_incompatible"),
        });
      }
      if (!findCatalogArtifact(entry, this.#platform, this.#arch)) {
        session.recordPhase("managed-install", "failed", "unsupported_platform");
        return finalize({
          ok: false,
          action: "failed",
          readiness: "unavailable",
          globalCommand: { active: false },
          warnings: [],
          diagnostic: diagnostic("unsupported_platform"),
        });
      }
      session.recordPhase("managed-install", "started", `${entry.version} from the reviewed catalog`);
      const installer = new ProviderCliInstaller({
        layout: this.#layout,
        platform: this.#platform,
        arch: this.#arch,
        ...(this.#deps.fetcher ? { fetcher: this.#deps.fetcher } : {}),
        ...(this.#deps.execFile ? { execFile: this.#deps.execFile } : {}),
      });
      let installed: Awaited<ReturnType<ProviderCliInstaller["install"]>>;
      try {
        installed = await installer.install(entry, provider);
      } catch (error) {
        logger.debug(
          { code: "managed_install_failed", provider, error: String(error) },
          "Provider CLI managed install failed",
        );
        const code =
          error instanceof ProviderCliInstallError
            ? error.code
            : isStorageOrPermissionError(error)
              ? "global_bin_unavailable"
              : "install_incomplete";
        session.recordPhase("managed-install", "failed", code);
        return finalize({
          ok: false,
          action: "failed",
          readiness: "unavailable",
          globalCommand: { active: false },
          warnings: [],
          diagnostic: diagnostic(code),
        });
      }
      const identity = await computeFileIdentity(installed.executablePath);
      newSelection = {
        kind: "managed",
        artifactId: installed.artifactId,
        version: installed.version,
        targetPath: identity.path,
        fingerprint: computeTargetFingerprint(identity, installed.version, installed.archiveSha256),
      };
      action = "installed-managed";
    }

    // Launcher and shim reconcile before the atomic selection replace; a failure here
    // leaves the prior selection unchanged.
    if (newSelection) {
      await reconcileProviderCliLauncher(this.#layout, entry, newSelection);
      if (pathUpdate) {
        await reconcileProviderCliShim(this.#layout, entry);
      }
      const now = this.#deps.now?.() ?? new Date();
      await writeProviderCliSelection(this.#layout, provider, newSelection, selection, now);
      if (newSelection.kind === "external") {
        session.recordPhase(
          "select",
          "completed",
          `${newSelection.version} external ${newSelection.executablePath} (${ranked.reasons.get(winner?.id ?? "") ?? "selected"})`,
        );
      } else {
        session.recordPhase(
          "managed-install",
          "completed",
          `${newSelection.version} ${providerCliSelectionTargetPath(newSelection)}`,
        );
      }
    } else {
      // No-op: still reconcile a drifted launcher/shim back to the healthy selection.
      const current = selection?.selection;
      if (current) {
        await reconcileProviderCliLauncher(this.#layout, entry, current);
        if (pathUpdate) {
          await reconcileProviderCliShim(this.#layout, entry);
        }
      }
      session.recordPhase("select", "completed", "current selection is already the best candidate");
    }

    session.recordPhase("verify", "started");
    const inspection = await this.inspect(provider);
    const ok = inspection.state === "ready";
    session.recordPhase(
      "verify",
      ok ? "completed" : "failed",
      ok ? "ready" : (inspection.diagnostic?.code ?? "unavailable"),
    );

    const selected = newSelection
      ? {
          path: providerCliSelectionTargetPath(newSelection),
          version: newSelection.version,
          source: newSelection.kind === "managed" ? "managed" : (winner?.sourceDir ?? "external"),
          trust: newSelection.kind === "managed" ? ("catalog-verified" as const) : newSelection.trust,
        }
      : inspection.selection
        ? {
            path: inspection.selection.path,
            version: inspection.selection.version,
            source: inspection.selection.kind,
            trust: inspection.selection.trust,
          }
        : undefined;

    return finalize({
      ok,
      action: ok ? action : "failed",
      ...(selected ? { selected } : {}),
      readiness: ok ? "ready" : "unavailable",
      globalCommand: {
        active: inspection.globalCommand.active,
        ...(inspection.globalCommand.path ? { path: inspection.globalCommand.path } : {}),
        ...(inspection.globalCommand.resolvedPath ? { resolvedPath: inspection.globalCommand.resolvedPath } : {}),
      },
      warnings: [...inspection.warnings],
      ...(inspection.diagnostic && !ok ? { diagnostic: inspection.diagnostic } : {}),
    });
  }
}

function isUnchangedIncumbent(
  selection: ProviderCliSelectionRecord | undefined,
  winner: ProviderCliCandidate,
): boolean {
  if (!selection || !winner.incumbent) return false;
  const current = selection.selection;
  if (winner.kind === "managed" && current.kind === "managed") {
    return current.targetPath === winner.path && current.fingerprint === winner.fingerprint;
  }
  if (winner.kind === "external" && current.kind === "external") {
    return (
      current.executablePath === winner.path &&
      current.fingerprint === winner.fingerprint &&
      current.trust === winner.trust
    );
  }
  return false;
}

/** A managed incumbent outside the catalog range blocks silent replacement. */
function incompatibleManagedIncumbent(
  selection: ProviderCliSelectionRecord | undefined,
  entry: ProviderCliCatalogEntry,
  detection: ProviderCliDetection,
): boolean {
  if (selection?.selection.kind !== "managed") return false;
  if (detection.candidates.some((candidate) => candidate.incumbent && candidate.kind === "managed")) return false;
  const targetPath = providerCliSelectionTargetPath(selection.selection);
  const incumbent = detection.ignored.find((entry) => entry.sourceDir === "selection" && entry.path === targetPath);
  return incumbent?.reason === "version-incompatible" && semver.gte(selection.selection.version, entry.version);
}

/** Upgrade an OpenTag-managed incumbent only when no eligible external remains. */
function shouldInstallManagedUpgrade(
  selection: ProviderCliSelectionRecord | undefined,
  entry: ProviderCliCatalogEntry,
  candidates: readonly ProviderCliCandidate[],
): boolean {
  return (
    selection?.selection.kind === "managed" &&
    semver.lt(selection.selection.version, entry.version) &&
    !candidates.some((candidate) => candidate.kind === "external")
  );
}

function buildCandidateReports(
  detection: ProviderCliDetection,
  ordered: readonly ProviderCliCandidate[],
  winner: ProviderCliCandidate | undefined,
  reasons: ReadonlyMap<string, string>,
  extraIgnored: readonly { path: string; sourceDir?: string; version?: string; reason: string }[] = [],
): ProviderCliCandidateReport[] {
  const reports: ProviderCliCandidateReport[] = [];
  for (const candidate of ordered) {
    const selected = winner !== undefined && candidate.id === winner.id;
    reports.push({
      path: candidate.path,
      version: candidate.version,
      trust: candidate.trust,
      disposition: selected ? "selected" : "ignored",
      reason: reasons.get(candidate.id) ?? (selected ? "selected" : "not selected"),
    });
  }
  const seen = new Set(ordered.map((candidate) => candidate.path));
  for (const entry of [...detection.ignored, ...extraIgnored]) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    reports.push({
      path: entry.path,
      ...(entry.version ? { version: entry.version } : {}),
      disposition: "ignored",
      reason: entry.reason,
    });
  }
  return reports;
}

function isStorageOrPermissionError(error: unknown): boolean {
  if (error instanceof RuntimeStorageError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}
