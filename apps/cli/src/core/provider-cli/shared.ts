import {
  type ProviderCliCandidate,
  type ProviderCliCatalogEntry,
  type ProviderCliExecFile,
  type ProviderCliFetcher,
  ProviderCliManager,
  type ProviderCliProvider,
  resolveAccountHome,
} from "@opentag/client";
import { channelConfig } from "../channel/config.js";

/**
 * Shared plumbing for the `opentag provider-cli` commands: provider flag parsing,
 * display labels, and injectable dependencies. The CLI flag accepts `lark` for the
 * Feishu/Lark provider to match the native `lark-cli` command name.
 */

export class ProviderCliUsageError extends Error {
  override readonly name = "ProviderCliUsageError";
}

/** Canonical provider order for multi-provider runs. */
const PROVIDER_FLAG_ORDER: readonly ProviderCliProvider[] = ["feishu", "slack"];

export function parseProviderCliProviderFlag(value: string): ProviderCliProvider[] {
  switch (value) {
    case "lark":
      return ["feishu"];
    case "slack":
      return ["slack"];
    case "all":
      return [...PROVIDER_FLAG_ORDER];
    default:
      throw new ProviderCliUsageError(`Unknown provider "${value}"; expected lark, slack, or all`);
  }
}

/** Short label used in human phase lines, matching the native command name. */
export function providerCliLabel(provider: ProviderCliProvider): "lark" | "slack" {
  return provider === "feishu" ? "lark" : "slack";
}

/** Stable, current-shell-safe repair command for Agent and human output. */
export function providerCliRepairCommand(provider: ProviderCliProvider | "all"): string {
  const flag = provider === "all" ? "all" : providerCliLabel(provider);
  return `"$HOME/.local/bin/${channelConfig.binName}" provider-cli ensure --provider ${flag}`;
}

const PROVIDER_CLI_MANUAL_REASONS = new Set([
  "global_bin_unavailable",
  "integrity_failed",
  "unsupported_platform",
  "version_incompatible",
]);

/** False when repeating ensure cannot change the local fact without a user or release change. */
export function providerCliCanAutoRepair(reason: string): boolean {
  return !PROVIDER_CLI_MANUAL_REASONS.has(reason);
}

/**
 * Failures that describe another OpenTag process holding the provider lock: transient, safe to
 * retry with bounded backoff once that operation finishes.
 */
const PROVIDER_CLI_TRANSIENT_REASONS = new Set(["operation_in_progress"]);

function isTransientProviderCliReason(reason: string | undefined): boolean {
  return reason !== undefined && PROVIDER_CLI_TRANSIENT_REASONS.has(reason);
}

export interface ProviderCliAggregateFailure {
  readonly category: "unavailable" | "dependency";
  readonly retryability: "backoff" | "immediate" | "never";
}

/**
 * One aggregate posture for a multi-provider run, classified from each failure's diagnostic so
 * the envelope never contradicts the nextActions: lock contention is transient and retried with
 * backoff; a failure a nextAction repairs by rerunning ensure is safe to retry immediately; a
 * manual or unrepairable failure must change before a retry can succeed, so it is never retried
 * blindly. The most conservative failure wins the aggregate. The exit code is not part of this
 * verdict: it is derived from the category through the shared command policy.
 */
export function providerCliAggregateFailure(
  failures: readonly { readonly diagnostic?: { readonly code: string } }[],
): ProviderCliAggregateFailure {
  const codes = failures.map((failure) => failure.diagnostic?.code);
  if (codes.length > 0 && codes.every(isTransientProviderCliReason)) {
    return { category: "unavailable", retryability: "backoff" };
  }
  const manual = codes.some(
    (code) => !isTransientProviderCliReason(code) && (code === undefined || !providerCliCanAutoRepair(code)),
  );
  if (codes.length === 0 || manual) return { category: "dependency", retryability: "never" };
  if (codes.some(isTransientProviderCliReason)) return { category: "dependency", retryability: "backoff" };
  return { category: "dependency", retryability: "immediate" };
}

export interface ProviderCliNextAction {
  readonly provider: ProviderCliProvider | "all";
  readonly command: string;
  readonly reason: string;
}

export interface ProviderCliCommandDeps {
  /** OS account home override; tests inject an isolated account root. */
  readonly accountHome?: string;
  /** Invoking-process environment override (PATH authority for detection). */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly catalog?: readonly ProviderCliCatalogEntry[];
  readonly fetcher?: ProviderCliFetcher;
  readonly execFile?: ProviderCliExecFile;
  /** Test-only hook: runs inside the provider lock before the winner is persisted. */
  readonly beforeWinnerReverify?: (winner: ProviderCliCandidate) => Promise<void>;
  /** Test-only hook: replaces the cross-process lock retry wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

export function writeStdout(deps: ProviderCliCommandDeps, chunk: string): void {
  if (deps.stdout) {
    deps.stdout(chunk);
    return;
  }
  process.stdout.write(chunk);
}

export function writeStderr(deps: ProviderCliCommandDeps, chunk: string): void {
  if (deps.stderr) {
    deps.stderr(chunk);
    return;
  }
  process.stderr.write(chunk);
}

/** Keep human diagnostics single-line and immune to terminal control injection. */
export function renderProviderCliHumanValue(value: string, maxLength = 1024): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    escaped += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return escaped.length <= maxLength ? escaped : `${escaped.slice(0, maxLength)}…`;
}

/** Parse the `--provider` flag; on a usage error, report to stderr and return undefined. */
export function parseProviderCliProvidersOrReport(
  value: string,
  stderr: (chunk: string) => void,
): ProviderCliProvider[] | undefined {
  try {
    return parseProviderCliProviderFlag(value);
  } catch (error) {
    if (error instanceof ProviderCliUsageError) {
      stderr(`${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

/** Build the manager with the command's injectable dependencies. */
export function createProviderCliManager(options: ProviderCliCommandDeps): ProviderCliManager {
  return new ProviderCliManager({
    accountHome: options.accountHome ?? resolveAccountHome(),
    ...(options.env ? { env: options.env } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.execFile ? { execFile: options.execFile } : {}),
    ...(options.beforeWinnerReverify ? { beforeWinnerReverify: options.beforeWinnerReverify } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}
