import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import { chmod, link, lstat, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import semver from "semver";
import { createLogger } from "../../observability/logger.js";
import {
  assertWithin,
  RuntimeStorageError,
  syncDurableDirectory,
  writeDurableFile,
} from "../../storage/durable-file.js";
import type { ProviderCliAccountLayout } from "./account-layout.js";
import type { ProviderCliProvider } from "./types.js";

export const PROVIDER_CLI_TURN_PLAN_SCHEMA_VERSION = 1;
export const MAX_PROVIDER_CLI_TURN_PLAN_BYTES = 16 * 1024;
export const MAX_PROVIDER_CLI_TURN_IDENTITY_BYTES = 4096;

const HOME_NAMESPACE_PATTERN = /^h-[0-9a-f]{40}$/;
const SESSION_KEY_PATTERN = /^s-[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^v1:[0-9a-f]{64}$/;
const logger = createLogger("runtime-provider-cli-turn-plan");

const SHARED_PLAN_KEYS = [
  "schemaVersion",
  "provider",
  "command",
  "selectionKind",
  "selectionVersion",
  "selectionGeneration",
  "targetPath",
  "fingerprint",
  "homeNamespace",
  "sessionId",
  "runId",
] as const;

const MANAGED_PLAN_KEYS = [...SHARED_PLAN_KEYS, "artifactId"] as const;
const EXTERNAL_PLAN_KEYS = SHARED_PLAN_KEYS;
const MANAGED_SLACK_PLAN_KEYS = [...MANAGED_PLAN_KEYS, "configDir"] as const;
const EXTERNAL_SLACK_PLAN_KEYS = [...EXTERNAL_PLAN_KEYS, "configDir"] as const;

export type ProviderCliTurnPlanErrorCode =
  | "selection_missing"
  | "selection_invalid"
  | "artifact_drifted"
  | "target_invalid"
  | "active_run_conflict"
  | "plan_invalid"
  | "plan_missing"
  | "provider_mismatch"
  | "run_mismatch"
  | "session_mismatch"
  | "home_mismatch"
  | "unsafe"
  | "too_large"
  | "invalid_identity"
  | "runner_failed";

export class ProviderCliTurnPlanError extends Error {
  override readonly name = "ProviderCliTurnPlanError";
  constructor(
    readonly code: ProviderCliTurnPlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ProviderCliTurnPlanCommand = "lark-cli" | "slack";

/**
 * Immutable exact-target plan for one visible Turn Run. The on-disk document is the
 * execution authority; later selection replacements must not rewrite it.
 */
type ProviderCliTurnPlanShared = {
  readonly schemaVersion: typeof PROVIDER_CLI_TURN_PLAN_SCHEMA_VERSION;
  readonly command: ProviderCliTurnPlanCommand;
  readonly selectionVersion: string;
  readonly selectionGeneration: number;
  readonly targetPath: string;
  readonly fingerprint: string;
  readonly homeNamespace: string;
  readonly sessionId: string;
  readonly runId: string;
};

type ProviderCliTurnPlanSelection =
  | { readonly selectionKind: "managed"; readonly artifactId: string }
  | { readonly selectionKind: "external" };

export type ProviderCliTurnPlan =
  | (ProviderCliTurnPlanShared &
      ProviderCliTurnPlanSelection & { readonly provider: "feishu"; readonly command: "lark-cli" })
  | (ProviderCliTurnPlanShared &
      ProviderCliTurnPlanSelection & {
        readonly provider: "slack";
        readonly command: "slack";
        readonly configDir: string;
      });

export function providerCliCommandForProvider(provider: ProviderCliProvider): ProviderCliTurnPlanCommand {
  return provider === "feishu" ? "lark-cli" : "slack";
}

/** Irreversible namespace for one canonical OpenTag Home under the account-global plans root. */
export function deriveProviderCliHomeNamespace(home: string): string {
  if (!isAbsolute(home)) {
    throw new ProviderCliTurnPlanError("invalid_identity", "The OpenTag Home must be an absolute path");
  }
  let canonical: string;
  try {
    canonical = realpathSync(resolve(home));
  } catch (error) {
    logger.debug(
      { code: "home_canonicalization_failed", error: String(error) },
      "Provider CLI Turn Home canonicalization failed",
    );
    throw new ProviderCliTurnPlanError("invalid_identity", "The OpenTag Home cannot be canonicalized");
  }
  return irreversibleKey("home", canonical);
}

/** Irreversible Session directory key; caller-supplied IDs never become path segments. */
export function deriveProviderCliSessionKey(sessionId: string): string {
  assertIdentity("sessionId", sessionId);
  return irreversibleKey("session", sessionId);
}

export function isProviderCliHomeNamespace(value: string): boolean {
  return HOME_NAMESPACE_PATTERN.test(value);
}

export function isProviderCliSessionKey(value: string): boolean {
  return SESSION_KEY_PATTERN.test(value);
}

export function providerCliPlanHomeDir(layout: ProviderCliAccountLayout, homeNamespace: string): string {
  assertSafeKey(homeNamespace, HOME_NAMESPACE_PATTERN, "home namespace");
  return join(layout.plans, homeNamespace);
}

export function providerCliPlanSessionDir(
  layout: ProviderCliAccountLayout,
  homeNamespace: string,
  sessionKey: string,
): string {
  assertSafeKey(sessionKey, SESSION_KEY_PATTERN, "session key");
  return join(providerCliPlanHomeDir(layout, homeNamespace), sessionKey);
}

export function providerCliTurnPlanPath(sessionDir: string): string {
  return join(sessionDir, "plan.json");
}

export function providerCliTurnLauncherPath(sessionDir: string, command: ProviderCliTurnPlanCommand): string {
  return join(sessionDir, command);
}

export function assertIdentity(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderCliTurnPlanError("invalid_identity", `Provider CLI Turn ${name} is missing`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PROVIDER_CLI_TURN_IDENTITY_BYTES) {
    throw new ProviderCliTurnPlanError("invalid_identity", `Provider CLI Turn ${name} exceeds the identity bound`);
  }
  if (/[\0\n\r]/.test(value)) {
    throw new ProviderCliTurnPlanError("invalid_identity", `Provider CLI Turn ${name} contains control characters`);
  }
  return value;
}

/** Absolute canonical Slack config leaf frozen into a Turn plan. Feishu callers must not supply one. */
export function assertProviderCliSlackConfigDir(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderCliTurnPlanError(
      "plan_invalid",
      "Slack Provider CLI Turn plans require an absolute config directory",
    );
  }
  const configDir = assertIdentity("configDir", value);
  if (!isAbsolute(configDir) || resolve(configDir) !== configDir) {
    throw new ProviderCliTurnPlanError("unsafe", "Slack config directory must be an absolute canonical path");
  }
  return configDir;
}

export function assertProviderCliTurnPlanConfigDir(provider: "slack", configDir: unknown): string;
export function assertProviderCliTurnPlanConfigDir(provider: "feishu", configDir: unknown): undefined;
export function assertProviderCliTurnPlanConfigDir(
  provider: ProviderCliProvider,
  configDir: unknown,
): string | undefined;
export function assertProviderCliTurnPlanConfigDir(
  provider: ProviderCliProvider,
  configDir: unknown,
): string | undefined {
  if (provider === "feishu") {
    if (configDir !== undefined) {
      throw new ProviderCliTurnPlanError(
        "plan_invalid",
        "Feishu Provider CLI Turn plans do not accept a config directory",
      );
    }
    return undefined;
  }
  return assertProviderCliSlackConfigDir(configDir);
}

export function parseProviderCliTurnPlan(value: unknown): ProviderCliTurnPlan {
  const record = requirePlanRecord(value);
  const shared = parsePlanSharedIdentity(record);
  return shared.provider === "slack" ? parseSlackTurnPlan(record, shared) : parseFeishuTurnPlan(record, shared);
}

function requirePlanRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== PROVIDER_CLI_TURN_PLAN_SCHEMA_VERSION) {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan schema is unsupported");
  }
  return value;
}

type ParsedTurnPlanIdentity = {
  schemaVersion: typeof PROVIDER_CLI_TURN_PLAN_SCHEMA_VERSION;
  provider: ProviderCliProvider;
  command: ProviderCliTurnPlanCommand;
  selectionVersion: string;
  selectionGeneration: number;
  targetPath: string;
  fingerprint: string;
  homeNamespace: string;
  sessionId: string;
  runId: string;
};

function parseSlackTurnPlan(record: Record<string, unknown>, shared: ParsedTurnPlanIdentity): ProviderCliTurnPlan {
  const configDir = assertProviderCliSlackConfigDir(record.configDir);
  if (record.selectionKind === "managed") {
    if (!hasExactKeys(record, MANAGED_SLACK_PLAN_KEYS) || !isNonEmptyString(record.artifactId)) {
      throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn managed plan is malformed");
    }
    return {
      ...shared,
      provider: "slack",
      command: "slack",
      selectionKind: "managed",
      artifactId: record.artifactId,
      configDir,
    };
  }
  if (record.selectionKind === "external") {
    if (!hasExactKeys(record, EXTERNAL_SLACK_PLAN_KEYS)) {
      throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn external plan is malformed");
    }
    return { ...shared, provider: "slack", command: "slack", selectionKind: "external", configDir };
  }
  throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan selection kind is unknown");
}

function parseFeishuTurnPlan(record: Record<string, unknown>, shared: ParsedTurnPlanIdentity): ProviderCliTurnPlan {
  if (record.selectionKind === "managed") {
    if (!hasExactKeys(record, MANAGED_PLAN_KEYS) || !isNonEmptyString(record.artifactId)) {
      throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn managed plan is malformed");
    }
    return {
      ...shared,
      provider: "feishu",
      command: "lark-cli",
      selectionKind: "managed",
      artifactId: record.artifactId,
    };
  }
  if (record.selectionKind === "external") {
    if (!hasExactKeys(record, EXTERNAL_PLAN_KEYS)) {
      throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn external plan is malformed");
    }
    return { ...shared, provider: "feishu", command: "lark-cli", selectionKind: "external" };
  }
  throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan selection kind is unknown");
}

function parsePlanSharedIdentity(value: Record<string, unknown>): ParsedTurnPlanIdentity {
  if (value.provider !== "feishu" && value.provider !== "slack") {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan provider is unknown");
  }
  const command = providerCliCommandForProvider(value.provider);
  if (value.command !== command) {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan command does not match provider");
  }
  const generation = parsePlanGeneration(value.selectionGeneration);
  const identity = parsePlanStringIdentity(value);
  return {
    schemaVersion: PROVIDER_CLI_TURN_PLAN_SCHEMA_VERSION,
    provider: value.provider,
    command,
    selectionVersion: identity.selectionVersion,
    selectionGeneration: generation,
    targetPath: identity.targetPath,
    fingerprint: identity.fingerprint,
    homeNamespace: identity.homeNamespace,
    sessionId: identity.sessionId,
    runId: identity.runId,
  };
}

function parsePlanGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan generation is malformed");
  }
  return value;
}

function parsePlanStringIdentity(value: Record<string, unknown>): {
  selectionVersion: string;
  targetPath: string;
  fingerprint: string;
  homeNamespace: string;
  sessionId: string;
  runId: string;
} {
  const { selectionVersion, targetPath, fingerprint, homeNamespace, sessionId, runId } = value;
  if (
    !isNonEmptyString(selectionVersion) ||
    !semver.valid(selectionVersion) ||
    !isNonEmptyString(targetPath) ||
    !isAbsolute(targetPath) ||
    !isFingerprint(fingerprint) ||
    typeof homeNamespace !== "string" ||
    !isProviderCliHomeNamespace(homeNamespace) ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(runId)
  ) {
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan identity is malformed");
  }
  return {
    selectionVersion,
    targetPath,
    fingerprint,
    homeNamespace,
    sessionId: assertIdentity("sessionId", sessionId),
    runId: assertIdentity("runId", runId),
  };
}

/** Bounded secure read of an immutable Turn plan. Missing files are `undefined`. */
export async function readProviderCliTurnPlan(path: string): Promise<ProviderCliTurnPlan | undefined> {
  const content = await readBoundedPrivatePlanFile(path);
  if (content === undefined) return undefined;
  try {
    return parseProviderCliTurnPlan(JSON.parse(content));
  } catch (error) {
    if (error instanceof ProviderCliTurnPlanError) throw error;
    logger.debug(
      { code: "plan_json_parse_failed", error: String(error) },
      "Provider CLI Turn plan JSON parsing failed",
    );
    throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan contains invalid JSON");
  }
}

async function readBoundedPrivatePlanFile(path: string): Promise<string | undefined> {
  const pathStatus = await lstatPlanFile(path);
  if (pathStatus === undefined) return undefined;
  assertPlanFileShapeAndSize(pathStatus);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertSamePlanFile(pathStatus, opened);
    assertPrivatePlanFile(opened);
    assertPlanFileSize(opened.size);
    return await readStablePlanContent(handle, opened);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan must not be a symlink");
    }
    logger.debug({ code: "plan_read_failed", error: String(error) }, "Provider CLI Turn plan read failed");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function lstatPlanFile(path: string): Promise<Stats | undefined> {
  let pathStatus: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStatus = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    logger.debug({ code: "plan_lstat_failed", error: String(error) }, "Provider CLI Turn plan stat failed");
    throw error;
  }
  return pathStatus;
}

function assertPlanFileShapeAndSize(status: Stats): void {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan must be a regular file");
  }
  assertPlanFileSize(status.size);
}

function assertSamePlanFile(pathStatus: Stats, opened: Stats): void {
  if (!opened.isFile() || opened.dev !== pathStatus.dev || opened.ino !== pathStatus.ino) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan changed during open");
  }
}

function assertPlanFileSize(size: number): void {
  if (size > MAX_PROVIDER_CLI_TURN_PLAN_BYTES) {
    throw new ProviderCliTurnPlanError("too_large", "Provider CLI Turn plan exceeds the read bound");
  }
}

async function readStablePlanContent(handle: Awaited<ReturnType<typeof open>>, opened: Stats): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_PROVIDER_CLI_TURN_PLAN_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    const read = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, null);
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;
  }
  assertPlanFileSize(bytesRead);
  const final = await handle.stat();
  if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || bytesRead !== opened.size) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan changed during read");
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
}

function assertPrivatePlanFile(status: Stats): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && status.uid !== currentUid) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan owner does not match the daemon account");
  }
  if ((status.mode & 0o077) !== 0) {
    throw new ProviderCliTurnPlanError("unsafe", "Provider CLI Turn plan permissions must be private");
  }
}

/**
 * Atomically publish a new plan. Returns `created` when this caller won the exclusive
 * create, or `exists` when another plan is already at the destination.
 */
export async function publishProviderCliTurnPlanExclusive(
  path: string,
  plan: ProviderCliTurnPlan,
): Promise<"created" | "exists"> {
  const parent = dirname(path);
  const temporary = resolve(parent, `.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(plan, undefined, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_PROVIDER_CLI_TURN_PLAN_BYTES) {
    throw new ProviderCliTurnPlanError("too_large", "Provider CLI Turn plan exceeds the write bound");
  }
  await writeDurableFile(temporary, content, 0o600);
  try {
    await link(temporary, path);
    await chmod(path, 0o600);
    await syncDurableDirectory(parent);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return "exists";
  } finally {
    await rm(temporary, { force: true });
  }
}

export function assertPlanWithinRoot(root: string, target: string): void {
  try {
    assertWithin(root, target);
  } catch (error) {
    if (error instanceof RuntimeStorageError) {
      throw new ProviderCliTurnPlanError("unsafe", error.message);
    }
    throw error;
  }
}

export function managedArtifactDigest(artifactId: string): string | undefined {
  const digest = artifactId.split("/").at(-1);
  return digest && digest.length > 0 ? digest : undefined;
}

function irreversibleKey(kind: "home" | "session", value: string): string {
  const digest = createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
  return `${kind[0]}-${digest.slice(0, 40)}`;
}

function assertSafeKey(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new ProviderCliTurnPlanError("unsafe", `Provider CLI Turn ${label} is not a derived key`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}
