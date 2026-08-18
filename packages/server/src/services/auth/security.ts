import { createHash, randomBytes } from "node:crypto";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

const TOKEN_FIELD_PATTERN = /("?(?:accessToken|refreshToken|code)"?\s*[:=]\s*)[^\s,}\]]+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~-]+/gi;

export function redactSecrets(value: string): string {
  return value.replace(TOKEN_FIELD_PATTERN, "$1[REDACTED]").replace(BEARER_PATTERN, "Bearer [REDACTED]");
}
