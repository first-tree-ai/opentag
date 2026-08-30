import type {
  ProviderCliCandidate,
  ProviderCliCatalogEntry,
  ProviderCliExecFile,
  ProviderCliFetcher,
  ProviderCliProvider,
} from "@opentag/client";

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
