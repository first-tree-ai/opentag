import { redactForLog } from "@opentag/shared";

/**
 * Object-storage contract for Agent Skill bundles.
 *
 * Skills are stored as one `tar.gz` object per Skill, behind this narrow interface with an S3
 * adapter and an in-memory fake for tests — the same interface/adapter/fake shape as
 * `WorkspaceObjectStore` in `services/sandboxes/workspace-object-store.ts`.
 *
 * Object keys are always derived here and never accepted from a caller, so a request can never
 * choose the bucket path it reads or writes. A failure is a typed `SkillObjectStoreError` carrying
 * only a sanitized message — never an upstream body or a credential.
 */

export type SkillObjectStoreErrorCode = "not_found" | "unavailable" | "rejected" | "invalid_response";

const MESSAGE_MAX_CHARS = 256;

/** Sanitized adapter failure: a bounded, redacted message; no upstream bodies or credentials. */
export class SkillObjectStoreError extends Error {
  readonly code: SkillObjectStoreErrorCode;
  readonly status?: number;

  constructor(code: SkillObjectStoreErrorCode, message: string, options: { status?: number } = {}) {
    super(sanitizeMessage(message));
    this.name = "SkillObjectStoreError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

function sanitizeMessage(message: string): string {
  return redactForLog(message.slice(0, MESSAGE_MAX_CHARS * 2))
    .replaceAll("\n", " ")
    .slice(0, MESSAGE_MAX_CHARS);
}

export interface SkillObjectStore {
  /** Writes exactly `body`; `meta.sha256` is the payload hash sent as `x-amz-content-sha256`. */
  put(key: string, body: Uint8Array, meta: { sha256: string }): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  head(key: string): Promise<{ bytes: number } | null>;
  delete(key: string): Promise<void>;
}

export interface SkillObjectKeyInput {
  /** Deployment-configured prefix, e.g. `skills`. */
  prefix: string;
  accountId: string;
  agentId: string;
  skillId: string;
  /** Lowercase hex SHA-256 of the stored archive. */
  sha256: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function requireSegment(label: string, value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("/") || !SEGMENT.test(value)) {
    throw new SkillObjectStoreError("rejected", `Skill object key ${label} is malformed`);
  }
  return value;
}

function requireUuid(label: string, value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SkillObjectStoreError("rejected", `Skill object key ${label} is not an identifier`);
  }
  return value;
}

/**
 * `<prefix>/accounts/<accountId>/agents/<agentId>/skills/<skillId>/<sha256>.tar.gz`.
 *
 * Every component is validated before it is joined, so a stored path can never carry a traversal
 * segment or an unexpected shape even if a caller of this helper misbehaves.
 */
export function skillObjectKey(input: SkillObjectKeyInput): string {
  const prefix = input.prefix
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => requireSegment("prefix", segment))
    .join("/");
  if (prefix.length === 0) throw new SkillObjectStoreError("rejected", "Skill object key prefix is empty");
  const accountId = requireUuid("accountId", input.accountId);
  const agentId = requireUuid("agentId", input.agentId);
  const skillId = requireUuid("skillId", input.skillId);
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) {
    throw new SkillObjectStoreError("rejected", "Skill object key sha256 is not a hex digest");
  }
  return `${prefix}/accounts/${accountId}/agents/${agentId}/skills/${skillId}/${input.sha256}.tar.gz`;
}
