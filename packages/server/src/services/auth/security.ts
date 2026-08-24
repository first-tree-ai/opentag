import { createHash, randomBytes } from "node:crypto";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

const TOKEN_FIELD_PATTERN =
  /("?(?:accessToken|refreshToken|code|botAccessToken|signingSecret|appSecret)"?\s*[:=]\s*)[^\s,}\]]+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~-]+/gi;
const SLACK_TOKEN_PATTERN = /\bxox[a-z]-[\w-]*/gi;

export function redactSecrets(value: string): string {
  return value
    .replace(TOKEN_FIELD_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SLACK_TOKEN_PATTERN, "[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@");
}

export function formatStartupError(error: unknown, knownSecrets: string[] = []): string {
  let detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  for (const secret of knownSecrets) {
    if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
  }
  return redactSecrets(detail);
}
