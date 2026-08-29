import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const MACOS_PROTECTED_HOME_SUBPATHS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Library/Mobile Documents",
  "Library/CloudStorage",
] as const;

export type ReadLink = (path: string) => string;

const MAX_SYMLINK_HOPS = 32;

export function protectedRoots(
  platform: NodeJS.Platform = process.platform,
  home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir(),
): string[] {
  if (platform !== "darwin") return [];
  return MACOS_PROTECTED_HOME_SUBPATHS.map((subpath) => join(home, subpath));
}

function fold(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function insideAny(path: string, roots: readonly string[]): boolean {
  const candidate = fold(path);
  return roots.some((root) => {
    const protectedRoot = fold(root);
    return candidate === protectedRoot || candidate.startsWith(`${protectedRoot}${sep}`);
  });
}

/**
 * Resolve symlink hops without entering a macOS TCC-protected directory.
 * Automatic background discovery must not trigger a Files & Folders prompt.
 */
export function resolveOutsideProtectedRoots(
  path: string,
  roots: readonly string[],
  readLink: ReadLink = readlinkSync,
): string | null {
  let pending = resolve(path).split(sep).filter(Boolean);
  let resolved: string = sep;
  let hops = 0;
  while (pending.length > 0) {
    const [head = "", ...rest] = pending;
    const candidate = join(resolved, head);
    if (insideAny(candidate, roots)) return null;
    let target: string | null = null;
    try {
      target = readLink(candidate);
    } catch {
      // A non-link, missing, or unreadable component is handled by the later access check.
    }
    if (target === null) {
      resolved = candidate;
      pending = rest;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) return null;
    const expanded = isAbsolute(target) ? target : join(resolved, target);
    pending = [...resolve(expanded).split(sep).filter(Boolean), ...rest];
    resolved = sep;
  }
  return resolved;
}

export function automaticCandidateAllowed(
  candidate: string,
  options: { platform?: NodeJS.Platform; home?: string; readLink?: ReadLink } = {},
): boolean {
  const roots = protectedRoots(options.platform, options.home);
  if (roots.length === 0) return true;
  return resolveOutsideProtectedRoots(candidate, roots, options.readLink) !== null;
}
