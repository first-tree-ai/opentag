import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { z } from "zod";
import type { ApplicationCipher } from "../../crypto.js";
import { feishuSetupAttemptContext } from "../credential-material.js";

/**
 * The encrypted setup context is the durable state of one Feishu setup attempt.
 *
 * A legacy QR-only attempt is exactly `{ qrUrl }` and lives only as long as the device code. A
 * durable candidate carries the registered App credentials under a versioned, strictly validated
 * envelope. The candidate is written before any upstream validation runs; it is never the active
 * credential until the existing activation transaction commits.
 *
 * Identity binding has two layers. The envelope always embeds `bindingId`/`attemptId` in the
 * authenticated plaintext, and every decode re-checks them against the row that owns the ciphertext,
 * which is the only binding the default (v1) cipher can offer. When the key ring is configured for
 * the v2 write version, `feishuSetupAttemptContext` is additionally passed as AAD, so the ciphertext
 * itself can only be opened under the same binding and attempt. Neither layer is claimed for the
 * other: v1 values open without AAD, v2 values require their exact context.
 */
export const FEISHU_SETUP_CANDIDATE_VERSION = 1;
export const FEISHU_SETUP_CANDIDATE_KIND = "feishu_candidate";

/** Ciphertext ceiling enforced before any decryption work; a corrupt row must not expand unbounded. */
const MAX_CONTEXT_CIPHERTEXT_BYTES = 64 * 1024;
/** Plaintext ceiling for one setup context, enforced after decryption as well. */
const MAX_CONTEXT_PLAINTEXT_BYTES = 32 * 1024;

const REQUIRED_TENANT_SCOPES = new Set<string>(FEISHU_REQUIRED_TENANT_SCOPES);

const CandidateMissingScopesSchema = z
  .array(z.string().min(1).max(160))
  .max(FEISHU_REQUIRED_TENANT_SCOPES.length)
  .refine(
    (scopes) => scopes.every((scope) => REQUIRED_TENANT_SCOPES.has(scope)) && new Set(scopes).size === scopes.length,
    { message: "missingScopes must be unique canonical required tenant scopes" },
  );

export const FeishuSetupCandidateObservationSchema = z
  .object({
    checkedAt: z.string().datetime(),
    reason: z.enum(["permissions_pending", "app_unavailable", "runtime_unavailable", "temporary_failure"]),
    missingScopes: CandidateMissingScopesSchema.optional(),
  })
  .strict();

export const FeishuSetupCandidateContextSchema = z
  .object({
    version: z.literal(FEISHU_SETUP_CANDIDATE_VERSION),
    kind: z.literal(FEISHU_SETUP_CANDIDATE_KIND),
    /** Bound into the ciphertext itself and re-checked after decryption against the row identity. */
    bindingId: z.string().uuid(),
    attemptId: z.string().uuid(),
    appId: z.string().min(1).max(255),
    appSecret: z.string().min(1).max(512),
    teamBrand: z.enum(["feishu", "lark"]).nullable(),
    savedAt: z.string().datetime(),
    nextCheckAt: z.string().datetime(),
    observation: FeishuSetupCandidateObservationSchema.nullable(),
  })
  .strict();

export const FeishuSetupQrContextSchema = z.object({ qrUrl: z.string().min(1) }).strict();

export type FeishuSetupCandidateObservation = z.infer<typeof FeishuSetupCandidateObservationSchema>;
export type FeishuSetupCandidateContext = z.infer<typeof FeishuSetupCandidateContextSchema>;
export type FeishuSetupQrContext = z.infer<typeof FeishuSetupQrContextSchema>;

export type DecodedFeishuSetupContext =
  | { kind: "candidate"; candidate: FeishuSetupCandidateContext }
  | { kind: "qr"; qrUrl: string };

/**
 * Encrypts a durable candidate. The stable row identity is passed so the envelope and the
 * decrypted identity agree; under a v2 cipher it is also the AAD the ciphertext is bound to.
 */
export function encodeFeishuSetupCandidate(
  cipher: ApplicationCipher,
  candidate: FeishuSetupCandidateContext,
  bindingId: string,
  attemptId: string,
): string {
  const parsed = FeishuSetupCandidateContextSchema.parse(candidate);
  return cipher.encryptCredential(JSON.stringify(parsed), feishuSetupAttemptContext(bindingId, attemptId));
}

/** Encrypts a legacy QR context with the same per-attempt identity the write path always used. */
export function encodeFeishuSetupQr(
  cipher: ApplicationCipher,
  qrUrl: string,
  bindingId: string,
  attemptId: string,
): string {
  return cipher.encryptCredential(
    JSON.stringify(FeishuSetupQrContextSchema.parse({ qrUrl })),
    feishuSetupAttemptContext(bindingId, attemptId),
  );
}

/**
 * Opens one setup context, failing closed on anything that is not a known, identity-matching
 * envelope. The ciphertext size is bounded before decryption and the plaintext size after it; a
 * candidate whose embedded binding/attempt does not match the row is treated as absent, so the setup
 * service never acts on an unauthenticated candidate identity. `strict` surfaces an authentication
 * failure (AAD mismatch) to read-only projections instead of treating it as absent.
 */
export function decodeFeishuSetupContext(
  cipher: ApplicationCipher,
  encrypted: string | null,
  bindingId: string,
  attemptId: string,
  options: { strict?: boolean } = {},
): DecodedFeishuSetupContext | undefined {
  if (!encrypted) return undefined;
  if (Buffer.byteLength(encrypted, "utf8") > MAX_CONTEXT_CIPHERTEXT_BYTES) return undefined;
  let plaintext: string;
  try {
    plaintext = cipher.decrypt(encrypted, feishuSetupAttemptContext(bindingId, attemptId));
  } catch (error) {
    // Read-only projections surface the authentication failure; recovery paths treat an
    // unreadable context as absent so a corrupt row cannot crash maintenance forever.
    if (options.strict) throw error;
    return undefined;
  }
  if (Buffer.byteLength(plaintext, "utf8") > MAX_CONTEXT_PLAINTEXT_BYTES) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  const candidate = FeishuSetupCandidateContextSchema.safeParse(payload);
  if (candidate.success) {
    if (candidate.data.bindingId !== bindingId || candidate.data.attemptId !== attemptId) return undefined;
    return { kind: "candidate", candidate: candidate.data };
  }
  const qr = FeishuSetupQrContextSchema.safeParse(payload);
  return qr.success ? { kind: "qr", qrUrl: qr.data.qrUrl } : undefined;
}
