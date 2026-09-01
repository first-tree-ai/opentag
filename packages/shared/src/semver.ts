import { z } from "zod";

/**
 * Strict SemVer 2.0.0 grammar. Channel targets, Client versions, and release coordinates are all
 * compared through this one module so the Server, the Client updater, and release tooling never
 * drift on what "newer" means.
 */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SemVerParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

export const SemVerStringSchema = z.string().regex(SEMVER_PATTERN, "Must be a strict SemVer 2.0.0 version");

export function parseSemVer(value: string): SemVerParts | undefined {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? match[5].split(".") : [],
  };
}

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

function requireSemVer(value: string | SemVerParts): SemVerParts {
  if (typeof value !== "string") return value;
  const parsed = parseSemVer(value);
  if (!parsed) throw new Error(`Not a valid SemVer version: ${JSON.stringify(value)}`);
  return parsed;
}

function compareNumericIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return compareNumericStrings(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareStrings(left, right);
}

function compareNumericStrings(left: string, right: string): -1 | 0 | 1 {
  // Strict SemVer forbids leading zeros in numeric identifiers, so length order is value order.
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCore(left: SemVerParts, right: SemVerParts): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function compareReleasePresence(left: readonly string[], right: readonly string[]): -1 | 0 | 1 | undefined {
  if (left.length > 0 && right.length > 0) return undefined;
  if (left.length === right.length) return 0;
  return left.length === 0 ? 1 : -1;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): -1 | 0 | 1 {
  const releasePresence = compareReleasePresence(left, right);
  if (releasePresence !== undefined) return releasePresence;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareNumericIdentifier(left[index] ?? "", right[index] ?? "");
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

/**
 * SemVer 2.0.0 precedence (section 11): build metadata is ignored, a prerelease ranks below its
 * release, numeric identifiers rank below alphanumeric ones, and a shorter prerelease set ranks
 * below a longer one when every shared identifier is equal.
 */
export function compareSemVer(leftInput: string | SemVerParts, rightInput: string | SemVerParts): -1 | 0 | 1 {
  const left = requireSemVer(leftInput);
  const right = requireSemVer(rightInput);
  const core = compareCore(left, right);
  return core === 0 ? comparePrerelease(left.prerelease, right.prerelease) : core;
}
