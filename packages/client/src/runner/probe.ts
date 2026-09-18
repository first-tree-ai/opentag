import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { linuxAmd64ProviderCliPlans } from "./catalog.js";
import type { RunnerIdentity } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RunnerToolProbe {
  readonly name: string;
  readonly detail?: string;
  readonly ok: boolean;
}

export interface ProbeRunnerToolsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly execFile?: typeof execFileAsync;
  readonly expected?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const DEFAULT_TOOLS: ReadonlyArray<{ name: string; args: readonly string[] }> = [
  { name: "node", args: ["--version"] },
  { name: "git", args: ["--version"] },
  { name: "gh", args: ["--version"] },
  { name: "pi", args: ["--version"] },
  { name: "context-tree", args: ["--version"] },
  { name: "opentag", args: ["--version"] },
];

/** Anchored output patterns; capture group 1 is the exact version to compare. Never substring. */
const TOOL_VERSION_PATTERNS: Readonly<Record<string, RegExp>> = {
  node: /^(v\d+\.\d+\.\d+)$/,
  git: /^git version (\d+\.\d+\.\d+)$/,
  gh: /^gh version (\d+\.\d+\.\d+) \([0-9-]+\)$/,
  pi: /^(\d+\.\d+\.\d+)$/,
  "context-tree": /^(\d+\.\d+\.\d+)$/,
  opentag: /^(\d+\.\d+\.\d+(?:-staging\.\d+\.\d+)?)$/,
};

/** The upstream Git version carried inside the Debian epoch pin, e.g. `1:2.39.5-0+deb12u3`. */
function gitUpstreamVersion(identity: RunnerIdentity): string | undefined {
  const match = /^\d+:(\d+\.\d+\.\d+)-/.exec(identity.toolLock.git ?? "");
  return match?.[1];
}

/** Exact expected versions derived from the image identity and the reviewed catalog. */
export function expectedFromIdentity(identity: RunnerIdentity): Readonly<Record<string, string>> {
  const catalogVersions = Object.fromEntries(
    linuxAmd64ProviderCliPlans().map((plan) => [plan.command, plan.version] as const),
  );
  const git = gitUpstreamVersion(identity);
  return {
    node: identity.nodeVersion.startsWith("v") ? identity.nodeVersion : `v${identity.nodeVersion}`,
    ...(git ? { git } : {}),
    ...(identity.toolLock.gh ? { gh: identity.toolLock.gh } : {}),
    pi: identity.piVersion,
    "context-tree": identity.contextTreeVersion,
    opentag: identity.version,
    ...catalogVersions,
  };
}

/** Catalog patterns are grouped full-line matches (capture group 1 preserved), never substring. */
function catalogLinePattern(catalogPattern: string): RegExp {
  return new RegExp(`^(?:${catalogPattern})$`);
}

/**
 * A probe is ok only when the first output line matches the tool's anchored pattern and the
 * captured version equals the expected one exactly (`0.84.20` must never satisfy `0.84.2`).
 */
function evaluateVersionProbe(
  name: string,
  detail: string,
  expected: Readonly<Record<string, string>> | undefined,
  catalogPattern?: string,
): boolean {
  const pattern = catalogPattern !== undefined ? catalogLinePattern(catalogPattern) : TOOL_VERSION_PATTERNS[name];
  if (!pattern) return true;
  const match = pattern.exec(detail);
  if (!match) return false;
  const want = expected?.[name];
  if (want !== undefined && match[1] !== want) return false;
  return true;
}

async function probeCommand(
  run: typeof execFileAsync,
  command: string,
  label: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  evaluate: (detail: string) => boolean,
): Promise<RunnerToolProbe> {
  try {
    const result = await run(command, [...args], { encoding: "utf8", env, timeout: timeoutMs, windowsHide: true });
    const detail = `${result.stdout}${result.stderr}`.trim();
    const firstLine = detail.split(/\r?\n/)[0] ?? "";
    // Anchored patterns evaluate the first output line; tools like gh print extra lines after it.
    return { name: label, ok: evaluate(firstLine), ...(firstLine ? { detail: firstLine.slice(0, 200) } : {}) };
  } catch (error) {
    const detail = probeFailureDetail(error);
    return { name: label, ok: false, ...(detail ? { detail } : {}) };
  }
}

/**
 * Best-effort diagnostic text for a failed probe command. execFile rejects with `stdout`/`stderr`
 * as (possibly empty) strings; `??` never falls through an empty string, so an empty capture must
 * explicitly fall back to the failure message or the error itself. Signal/killed/code metadata is
 * preserved when present so a native startup timeout or kill is diagnosable without a re-run.
 */
function probeFailureDetail(error: unknown): string {
  const err = error as {
    message?: string;
    stderr?: string;
    stdout?: string;
    killed?: boolean;
    signal?: string;
    code?: number | string;
  };
  const captured = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  const fallback = (typeof err.message === "string" ? err.message : String(error)).trim();
  const status = [
    err.code !== undefined && err.code !== null ? `code=${err.code}` : "",
    err.signal ? `signal=${err.signal}` : "",
    err.killed ? "killed" : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return `${captured || fallback}${status ? ` (${status})` : ""}`.trim().slice(0, 400);
}

export async function probeRunnerTools(options: ProbeRunnerToolsOptions = {}): Promise<readonly RunnerToolProbe[]> {
  const run = options.execFile ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const env = { ...(options.env ?? process.env), HOME: options.env?.HOME ?? "/nonexistent-runner-home" };
  const results: RunnerToolProbe[] = [];
  for (const tool of DEFAULT_TOOLS) {
    results.push(
      await probeCommand(run, tool.name, tool.name, tool.args, env, timeoutMs, (detail) =>
        evaluateVersionProbe(tool.name, detail, options.expected),
      ),
    );
  }
  for (const plan of linuxAmd64ProviderCliPlans()) {
    results.push(
      await probeCommand(run, plan.command, plan.command, plan.probes.versionArgs, env, timeoutMs, (detail) =>
        evaluateVersionProbe(plan.command, detail, options.expected, plan.probes.versionPattern),
      ),
    );
    results.push(
      await probeCommand(
        run,
        plan.command,
        `${plan.command}:surface`,
        plan.probes.surfaceArgs,
        env,
        timeoutMs,
        (detail) => plan.surfacePattern.test(detail),
      ),
    );
  }
  return results;
}

export function runnerToolsReady(probes: readonly RunnerToolProbe[]): boolean {
  return probes.every((probe) => probe.ok);
}
