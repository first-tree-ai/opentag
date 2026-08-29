import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { AgentRuntimeProvider } from "@opentag/shared";
import { automaticCandidateAllowed } from "./protected-paths.js";

export type AgentRuntimeExecutableSource = "explicit" | "path" | "well-known" | "desktop-app";

export interface ResolvedAgentRuntimeExecutable {
  provider: AgentRuntimeProvider;
  path: string;
  source: AgentRuntimeExecutableSource;
}

export interface AgentRuntimeCliInstallation {
  provider: AgentRuntimeProvider;
  displayName: string;
  installed: boolean;
  path?: string;
  source?: AgentRuntimeExecutableSource;
}

type Candidate = { path: string; source: Exclude<AgentRuntimeExecutableSource, "explicit"> };

export interface ResolveAgentRuntimeExecutableOptions {
  access?: (path: string, mode: number) => Promise<void>;
  realpath?: (path: string) => Promise<string>;
  platform?: NodeJS.Platform;
  home?: string;
  pathDelimiter?: string;
  wellKnownDirs?: (home: string, platform: NodeJS.Platform) => readonly string[];
  desktopAppDirs?: (home: string, platform: NodeJS.Platform) => readonly string[];
  candidateAllowed?: (path: string, options: { platform: NodeJS.Platform; home: string }) => boolean;
}

export interface ProbeAgentRuntimeCliInstallationsOptions extends ResolveAgentRuntimeExecutableOptions {
  environment?: NodeJS.ProcessEnv;
  commands?: Partial<Record<AgentRuntimeProvider, string>>;
}

const PROVIDERS = [
  { provider: "codex", displayName: "Codex CLI", command: "codex" },
  { provider: "claude-code", displayName: "Claude Code CLI", command: "claude" },
] as const;

/** Cheap, spawn-free directories mirrored from First Tree's install-only capability discovery. */
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
  const checkAccess = options.access ?? access;
  const canonicalize = options.realpath ?? realpath;
  if (isAbsolute(command)) {
    await checkAccess(command, constants.X_OK);
    return { provider, path: await canonicalize(command), source: "explicit" };
  }

  const platform = options.platform ?? process.platform;
  const home = options.home ?? environment.HOME ?? homedir();
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const wellKnownDirs = options.wellKnownDirs ?? wellKnownAgentRuntimeBinDirs;
  const desktopAppDirs = options.desktopAppDirs ?? codexDesktopAppBinDirs;
  const candidateAllowed = options.candidateAllowed ?? automaticCandidateAllowed;
  const extensions = platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const seen = new Set<string>();

  for (const candidate of executableCandidates({
    command,
    desktopAppDirs: provider === "codex" ? desktopAppDirs(home, platform) : [],
    extensions,
    pathDirs: (environment.PATH ?? "").split(pathDelimiter).filter(Boolean),
    wellKnownDirs: wellKnownDirs(home, platform),
  })) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    if (!candidateAllowed(candidate.path, { platform, home })) continue;
    try {
      await checkAccess(candidate.path, constants.X_OK);
      return { provider, path: await canonicalize(candidate.path), source: candidate.source };
    } catch {
      // Continue to the next automatic candidate.
    }
  }
  throw new Error(`The ${provider} Agent Runtime CLI is not installed`);
}

export async function probeAgentRuntimeCliInstallations(
  options: ProbeAgentRuntimeCliInstallationsOptions = {},
): Promise<AgentRuntimeCliInstallation[]> {
  const environment = options.environment ?? process.env;
  return Promise.all(
    PROVIDERS.map(async ({ provider, displayName, command }) => {
      try {
        const resolved = await resolveAgentRuntimeExecutable(
          provider,
          options.commands?.[provider] ?? command,
          environment,
          options,
        );
        return { provider, displayName, installed: true, path: resolved.path, source: resolved.source };
      } catch {
        return { provider, displayName, installed: false };
      }
    }),
  );
}

function* executableCandidates(options: {
  command: string;
  extensions: readonly string[];
  pathDirs: readonly string[];
  wellKnownDirs: readonly string[];
  desktopAppDirs: readonly string[];
}): Generator<Candidate> {
  for (const [source, directories] of [
    ["path", options.pathDirs],
    ["well-known", options.wellKnownDirs],
    ["desktop-app", options.desktopAppDirs],
  ] as const) {
    for (const directory of directories) {
      for (const extension of options.extensions) {
        yield { path: join(directory, `${options.command}${extension}`), source };
      }
    }
  }
}
