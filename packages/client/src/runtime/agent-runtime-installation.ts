import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { AgentRuntimeProvider } from "@opentag/shared";
import { type ActiveVersionManager, versionManagerBinDirs } from "./install-locations.js";
import { type LoginShellPathDeps, probeLoginShellPath } from "./login-shell-path.js";
import { automaticCandidateAllowed } from "./protected-paths.js";

export type AgentRuntimeExecutableSource =
  | "explicit"
  | "caller-path"
  | "well-known"
  | "login-shell"
  | "version-manager"
  | "desktop-app";

export interface ResolvedAgentRuntimeExecutable {
  provider: AgentRuntimeProvider;
  path: string;
  source: AgentRuntimeExecutableSource;
}

export type AgentRuntimeCliInstallation =
  | {
      provider: "codex" | "claude-code";
      displayName: string;
      status: "installed";
      path: string;
      source: AgentRuntimeExecutableSource;
    }
  | {
      provider: "codex" | "claude-code";
      displayName: string;
      status: "not-installed";
    }
  | {
      provider: "codex" | "claude-code";
      displayName: string;
      status: "unknown";
      detail: string;
    };

type Candidate = { path: string; source: Exclude<AgentRuntimeExecutableSource, "explicit"> };

export interface ResolveAgentRuntimeExecutableOptions {
  access?: (path: string, mode: number) => Promise<void>;
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<Pick<Stats, "isFile">>;
  platform?: NodeJS.Platform;
  home?: string;
  pathDelimiter?: string;
  wellKnownDirs?: (home: string, platform: NodeJS.Platform) => readonly string[];
  desktopAppDirs?: (home: string, platform: NodeJS.Platform) => readonly string[];
  candidateAllowed?: (path: string, options: { platform: NodeJS.Platform; home: string }) => boolean;
  /**
   * Whether to consult the login-shell PATH (which may spawn a shell) and the
   * version-manager fallback that depends on it. Default `true`. Set `false` on
   * the daemon's pre-connect readiness path so startup never blocks on a login
   * shell. Later refresh and Turn-triggered readiness pass `true`.
   */
  includeLoginShell?: boolean | (() => boolean);
  loginShellPathDirs?: () => Promise<readonly string[]> | readonly string[];
  loginShellEnv?: () => ActiveVersionManager | Promise<ActiveVersionManager>;
  runShell?: LoginShellPathDeps["runShell"];
  loginShellSpawn?: LoginShellPathDeps["spawn"];
  versionManagerDirs?: (home: string, active: ActiveVersionManager) => readonly string[];
}

export interface ProbeAgentRuntimeCliInstallationsOptions extends ResolveAgentRuntimeExecutableOptions {
  environment?: NodeJS.ProcessEnv;
  commands?: Partial<Record<"codex" | "claude-code", string>>;
}

const PROVIDERS = [
  { provider: "codex", displayName: "Codex CLI", command: "codex" },
  { provider: "claude-code", displayName: "Claude Code CLI", command: "claude" },
] as const;

export class AgentRuntimeExecutableNotFoundError extends Error {
  override readonly name = "AgentRuntimeExecutableNotFoundError";
}

export class AgentRuntimeExecutableDiscoveryError extends Error {
  override readonly name = "AgentRuntimeExecutableDiscoveryError";
}

/** Cheap, spawn-free directories mirrored from First Tree's install-only discovery. */
export function wellKnownAgentRuntimeBinDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "share", "pnpm"),
    ...(platform === "darwin" ? [join(home, "Library", "pnpm")] : []),
    join(home, ".bun", "bin"),
    ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

export function codexDesktopAppBinDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  return [
    join("/Applications", "ChatGPT.app", "Contents", "Resources"),
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources"),
    join("/Applications", "Codex.app", "Contents", "Resources"),
    join(home, "Applications", "Codex.app", "Contents", "Resources"),
  ];
}

export function includeLoginShellEnabled(options: ResolveAgentRuntimeExecutableOptions = {}): boolean {
  const value = options.includeLoginShell;
  if (typeof value === "function") return value();
  return value !== false;
}

/**
 * Same-Provider candidate fallback is allowed only when the full readiness
 * result contains at least one issue and every issue is binary-shaped.
 * Credential, configuration, transient, mixed, or empty results must not
 * advance, and another Provider must never be substituted.
 */
export function canAdvanceRuntimeCandidate(result: {
  readonly ready: boolean;
  readonly issues: readonly { readonly code: string }[];
}): boolean {
  if (result.ready || result.issues.length === 0) return false;
  return result.issues.every((issue) => issue.code === "artifact_missing" || issue.code === "version_incompatible");
}

export async function resolveAgentRuntimeExecutable(
  provider: AgentRuntimeProvider,
  command: string,
  environment: NodeJS.ProcessEnv,
  options: ResolveAgentRuntimeExecutableOptions = {},
): Promise<ResolvedAgentRuntimeExecutable> {
  for await (const candidate of iterateAgentRuntimeExecutables(provider, command, environment, options)) {
    return candidate;
  }
  throw new AgentRuntimeExecutableNotFoundError(`The ${provider} Agent Runtime CLI is not installed`);
}

/**
 * Lazy installed-candidate sequence. Later, more expensive sources are only
 * evaluated when the consumer asks for the next candidate — the common case of
 * a single working hit therefore keeps today's cost. An absolute explicit
 * command remains one candidate and never gains fallback sources.
 */
export async function* iterateAgentRuntimeExecutables(
  provider: AgentRuntimeProvider,
  command: string,
  environment: NodeJS.ProcessEnv,
  options: ResolveAgentRuntimeExecutableOptions = {},
): AsyncGenerator<ResolvedAgentRuntimeExecutable> {
  const dependencies = {
    access: options.access ?? access,
    realpath: options.realpath ?? realpath,
    stat: options.stat ?? stat,
  };
  if (isAbsolute(command)) {
    const outcome = await inspectExecutableCandidate(command, dependencies);
    if (outcome.status !== "installed") {
      if (outcome.status === "unknown") throw new AgentRuntimeExecutableDiscoveryError(outcome.detail);
      throw new AgentRuntimeExecutableNotFoundError(`The ${provider} Agent Runtime CLI is not installed`);
    }
    yield { provider, path: outcome.path, source: "explicit" };
    return;
  }

  const platform = options.platform ?? process.platform;
  const home = options.home ?? environment.HOME ?? homedir();
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const wellKnownDirs = options.wellKnownDirs ?? wellKnownAgentRuntimeBinDirs;
  const desktopAppDirs = options.desktopAppDirs ?? codexDesktopAppBinDirs;
  const candidateAllowed = options.candidateAllowed ?? automaticCandidateAllowed;
  const extensions = platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const seenSearchPaths = new Set<string>();
  const seenResolvedPaths = new Set<string>();
  let firstUnknown: string | undefined;
  let yielded = false;

  const fromDirectories = async function* (
    directories: readonly string[],
    source: Exclude<AgentRuntimeExecutableSource, "explicit">,
  ): AsyncGenerator<ResolvedAgentRuntimeExecutable> {
    for (const candidate of executableCandidatesFrom({ command, directories, extensions, source })) {
      if (seenSearchPaths.has(candidate.path)) continue;
      seenSearchPaths.add(candidate.path);
      try {
        if (!candidateAllowed(candidate.path, { platform, home })) continue;
      } catch {
        firstUnknown ??= "An automatic Runtime candidate could not be inspected safely";
        continue;
      }
      const outcome = await inspectExecutableCandidate(candidate.path, dependencies);
      if (outcome.status === "installed") {
        if (seenResolvedPaths.has(outcome.path)) continue;
        seenResolvedPaths.add(outcome.path);
        yielded = true;
        yield { provider, path: outcome.path, source: candidate.source };
        continue;
      }
      if (outcome.status === "unknown") firstUnknown ??= outcome.detail;
    }
  };

  yield* fromDirectories((environment.PATH ?? "").split(pathDelimiter).filter(Boolean), "caller-path");
  yield* fromDirectories(wellKnownDirs(home, platform), "well-known");

  if (provider === "codex") {
    yield* fromDirectories(desktopAppDirs(home, platform), "desktop-app");
  }

  if (includeLoginShellEnabled(options) && platform !== "win32") {
    const login = await resolveLoginShellLayer(home, platform, environment, options);
    if (login) {
      yield* fromDirectories(login.dirs, "login-shell");
      yield* fromDirectories(login.versionManagerDirs, "version-manager");
    }
  }

  if (!yielded && firstUnknown) throw new AgentRuntimeExecutableDiscoveryError(firstUnknown);
}

export async function probeAgentRuntimeCliInstallations(
  options: ProbeAgentRuntimeCliInstallationsOptions = {},
): Promise<AgentRuntimeCliInstallation[]> {
  const environment = options.environment ?? process.env;
  return Promise.all(
    PROVIDERS.map(async ({ provider, displayName, command }): Promise<AgentRuntimeCliInstallation> => {
      try {
        const resolved = await resolveAgentRuntimeExecutable(
          provider,
          options.commands?.[provider] ?? command,
          environment,
          options,
        );
        return { provider, displayName, status: "installed", path: resolved.path, source: resolved.source };
      } catch (error) {
        if (error instanceof AgentRuntimeExecutableNotFoundError) {
          return { provider, displayName, status: "not-installed" };
        }
        return {
          provider,
          displayName,
          status: "unknown",
          detail: safeErrorDetail(error, "Runtime installation could not be determined"),
        };
      }
    }),
  );
}

async function resolveLoginShellLayer(
  home: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  options: ResolveAgentRuntimeExecutableOptions,
): Promise<{ dirs: readonly string[]; versionManagerDirs: readonly string[] } | undefined> {
  const versionManagerOptions = { env: environment, home, platform } as const;
  if (options.loginShellPathDirs) {
    const dirs = await options.loginShellPathDirs();
    const active = (await options.loginShellEnv?.()) ?? {};
    const versionDirs = options.versionManagerDirs
      ? options.versionManagerDirs(home, active)
      : versionManagerBinDirs(home, { ...versionManagerOptions, active });
    return { dirs, versionManagerDirs: versionDirs };
  }
  const probed = await probeLoginShellPath({
    environment,
    home,
    platform,
    runShell: options.runShell,
    spawn: options.loginShellSpawn,
  });
  if (!probed.ok) return undefined;
  const versionDirs = options.versionManagerDirs
    ? options.versionManagerDirs(home, probed.env)
    : versionManagerBinDirs(home, { ...versionManagerOptions, active: probed.env });
  return { dirs: probed.dirs, versionManagerDirs: versionDirs };
}

async function inspectExecutableCandidate(
  candidate: string,
  dependencies: Pick<Required<ResolveAgentRuntimeExecutableOptions>, "access" | "realpath" | "stat">,
): Promise<{ status: "installed"; path: string } | { status: "absent" } | { status: "unknown"; detail: string }> {
  try {
    const status = await dependencies.stat(candidate);
    if (!status.isFile()) return { status: "absent" };
  } catch (error) {
    return missingOrUnknown(error);
  }
  try {
    await dependencies.access(candidate, constants.X_OK);
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException | undefined)?.code === "EACCES") {
      return { status: "absent" };
    }
    return { status: "unknown", detail: "A Runtime candidate's executable permission could not be inspected" };
  }
  try {
    return { status: "installed", path: await dependencies.realpath(candidate) };
  } catch (error) {
    return missingOrUnknown(error);
  }
}

function missingOrUnknown(error: unknown): { status: "absent" } | { status: "unknown"; detail: string } {
  if (isMissing(error)) return { status: "absent" };
  return { status: "unknown", detail: "A Runtime candidate could not be inspected safely" };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function safeErrorDetail(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) return fallback;
  return error.message.slice(0, 300);
}

function* executableCandidatesFrom(options: {
  command: string;
  extensions: readonly string[];
  directories: readonly string[];
  source: Exclude<AgentRuntimeExecutableSource, "explicit">;
}): Generator<Candidate> {
  for (const directory of options.directories) {
    if (!isAbsolute(directory)) continue;
    for (const extension of options.extensions) {
      yield { path: join(directory, `${options.command}${extension}`), source: options.source };
    }
  }
}
