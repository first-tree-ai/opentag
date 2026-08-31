import { isAbsolute } from "node:path";
import semver from "semver";
import { RuntimeStorageError } from "../../storage/durable-file.js";
import { readPrivateJson, writePrivateJson } from "../../storage/private-json-file.js";
import { type ProviderCliAccountLayout, providerCliStateFilePath } from "./account-layout.js";
import type { ProviderCliProvider, ProviderCliTrust } from "./types.js";

export const PROVIDER_CLI_SELECTION_SCHEMA_VERSION = 1;

/**
 * Exactly two selections exist. A managed selection pins an immutable catalog artifact;
 * an external selection pins a detected executable by canonical path and fingerprint.
 */
export type ProviderCliSelection =
  | {
      readonly kind: "managed";
      readonly artifactId: string;
      readonly version: string;
      readonly targetPath: string;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "external";
      readonly executablePath: string;
      readonly fingerprint: string;
      readonly trust: ProviderCliTrust;
      readonly version: string;
    };

export interface ProviderCliSelectionRecord {
  readonly schemaVersion: typeof PROVIDER_CLI_SELECTION_SCHEMA_VERSION;
  readonly provider: ProviderCliProvider;
  /** Monotonic per provider; every atomic replace increments it. */
  readonly generation: number;
  readonly updatedAt: string;
  readonly selection: ProviderCliSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTrust(value: unknown): value is ProviderCliTrust {
  return value === "catalog-verified" || value === "compatible-unverified";
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^v1:[0-9a-f]{64}$/.test(value);
}

function parseSelection(value: unknown, provider: ProviderCliProvider): ProviderCliSelection {
  if (!isRecord(value)) throw new RuntimeStorageError("invalid", "Provider CLI selection is malformed");
  if (value.kind === "managed") {
    const required = ["kind", "artifactId", "version", "targetPath", "fingerprint"];
    if (!required.every((key) => isNonEmptyString(value[key]))) {
      throw new RuntimeStorageError("invalid", "Provider CLI managed selection is malformed");
    }
    if (
      !isAbsolute(value.targetPath as string) ||
      !semver.valid(value.version as string) ||
      !isFingerprint(value.fingerprint)
    ) {
      throw new RuntimeStorageError("invalid", "Provider CLI managed selection identity is malformed");
    }
    return {
      kind: "managed",
      artifactId: value.artifactId as string,
      version: value.version as string,
      targetPath: value.targetPath as string,
      fingerprint: value.fingerprint as string,
    };
  }
  if (value.kind === "external") {
    const required = ["kind", "executablePath", "fingerprint", "version"];
    if (
      !required.every((key) => isNonEmptyString(value[key])) ||
      !isTrust(value.trust) ||
      !semver.valid(value.version as string) ||
      !isFingerprint(value.fingerprint)
    ) {
      throw new RuntimeStorageError("invalid", "Provider CLI external selection is malformed");
    }
    if (!isAbsolute(value.executablePath as string)) {
      throw new RuntimeStorageError("invalid", "Provider CLI external path must be absolute");
    }
    return {
      kind: "external",
      executablePath: value.executablePath as string,
      fingerprint: value.fingerprint as string,
      trust: value.trust,
      version: value.version as string,
    };
  }
  throw new RuntimeStorageError("invalid", `Provider CLI selection kind is unknown for ${provider}`);
}

export function parseProviderCliSelectionRecord(value: unknown): ProviderCliSelectionRecord {
  if (!isRecord(value) || value.schemaVersion !== PROVIDER_CLI_SELECTION_SCHEMA_VERSION) {
    throw new RuntimeStorageError("invalid", "Provider CLI selection schema is unsupported");
  }
  if (
    (value.provider !== "feishu" && value.provider !== "slack") ||
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 1 ||
    !isNonEmptyString(value.updatedAt) ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new RuntimeStorageError("invalid", "Provider CLI selection record is malformed");
  }
  return {
    schemaVersion: PROVIDER_CLI_SELECTION_SCHEMA_VERSION,
    provider: value.provider,
    generation: value.generation,
    updatedAt: value.updatedAt,
    selection: parseSelection(value.selection, value.provider),
  };
}

/** Read the current selection; missing state is `undefined`, malformed state throws. */
export async function readProviderCliSelection(
  layout: ProviderCliAccountLayout,
  provider: ProviderCliProvider,
): Promise<ProviderCliSelectionRecord | undefined> {
  return readPrivateJson(layout.root, providerCliStateFilePath(layout, provider), (value) => {
    const record = parseProviderCliSelectionRecord(value);
    if (record.provider !== provider) {
      throw new RuntimeStorageError("invalid", "Provider CLI selection provider does not match its state file");
    }
    return record;
  });
}

/** Atomically replace the selection record (0600, write-temp-then-rename). */
export async function writeProviderCliSelection(
  layout: ProviderCliAccountLayout,
  provider: ProviderCliProvider,
  selection: ProviderCliSelection,
  previous: ProviderCliSelectionRecord | undefined,
  now: Date = new Date(),
): Promise<ProviderCliSelectionRecord> {
  const record: ProviderCliSelectionRecord = {
    schemaVersion: PROVIDER_CLI_SELECTION_SCHEMA_VERSION,
    provider,
    generation: (previous?.generation ?? 0) + 1,
    updatedAt: now.toISOString(),
    selection,
  };
  await writePrivateJson(layout.root, providerCliStateFilePath(layout, provider), record);
  return record;
}

/** Canonical target path a selection executes, regardless of kind. */
export function providerCliSelectionTargetPath(selection: ProviderCliSelection): string {
  return selection.kind === "managed" ? selection.targetPath : selection.executablePath;
}

/** True when two selections execute the identical artifact. */
export function providerCliSelectionsEqual(left: ProviderCliSelection, right: ProviderCliSelection): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "managed" && right.kind === "managed") {
    return (
      left.artifactId === right.artifactId &&
      left.targetPath === right.targetPath &&
      left.fingerprint === right.fingerprint
    );
  }
  if (left.kind === "external" && right.kind === "external") {
    return left.executablePath === right.executablePath && left.fingerprint === right.fingerprint;
  }
  return false;
}
