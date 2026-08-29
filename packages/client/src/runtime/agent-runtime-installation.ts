import { constants, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { AgentRuntimeProvider } from "@opentag/shared";
import { automaticCandidateAllowed } from "./protected-paths.js";

export type AgentRuntimeExecutableSource = "explicit" | "caller-path" | "well-known" | "desktop-app";

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

export async function resolveAgentRuntimeExecutable(
  provider: AgentRuntimeProvider,
  command: string,
  environment: NodeJS.ProcessEnv,
  options: ResolveAgentRuntimeExecutableOptions = {},
): Promise<ResolvedAgentRuntimeExecutable> {
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
    return { provider, path: outcome.path, source: "explicit" };
  }

  const platform = options.platform ?? process.platform;
  const home = options.home ?? environment.HOME ?? homedir();
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const wellKnownDirs = options.wellKnownDirs ?? wellKnownAgentRuntimeBinDirs;
  const desktopAppDirs = options.desktopAppDirs ?? codexDesktopAppBinDirs;
  const candidateAllowed = options.candidateAllowed ?? automaticCandidateAllowed;
  const extensions = platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const seen = new Set<string>();
  let firstUnknown: string | undefined;

  for (const candidate of executableCandidates({
    command,
    desktopAppDirs: provider === "codex" ? desktopAppDirs(home, platform) : [],
    extensions,
    pathDirs: (environment.PATH ?? "").split(pathDelimiter).filter(Boolean),
    wellKnownDirs: wellKnownDirs(home, platform),
  })) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      if (!candidateAllowed(candidate.path, { platform, home })) continue;
    } catch {
      firstUnknown ??= "An automatic Runtime candidate could not be inspected safely";
      continue;
    }
    const outcome = await inspectExecutableCandidate(candidate.path, dependencies);
    if (outcome.status === "installed") {
      return { provider, path: outcome.path, source: candidate.source };
    }
    if (outcome.status === "unknown") firstUnknown ??= outcome.detail;
  }
  if (firstUnknown) throw new AgentRuntimeExecutableDiscoveryError(firstUnknown);
  throw new AgentRuntimeExecutableNotFoundError(`The ${provider} Agent Runtime CLI is not installed`);
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

function* executableCandidates(options: {
  command: string;
  extensions: readonly string[];
  pathDirs: readonly string[];
  wellKnownDirs: readonly string[];
  desktopAppDirs: readonly string[];
}): Generator<Candidate> {
  for (const [source, directories] of [
    ["caller-path", options.pathDirs],
    ["well-known", options.wellKnownDirs],
    ["desktop-app", options.desktopAppDirs],
  ] as const) {
    for (const directory of directories) {
      if (!isAbsolute(directory)) continue;
      for (const extension of options.extensions) {
        yield { path: join(directory, `${options.command}${extension}`), source };
      }
    }
  }
}
