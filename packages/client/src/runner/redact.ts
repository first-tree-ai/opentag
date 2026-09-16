const JSON_SECRET_FIELD =
  /("[^"]*(?:api[_-]?key|key|token|secret|password|authorization)[^"]*"\s*:\s*")((?:\\.|[^"\\])+)(")/gi;
const SECRET_PATTERN =
  /(api[_-]?key|token|secret|password|authorization|bearer)(=|\s*[:=]\s*)((?:bearer\s+)?[^\s"',}]+)/gi;
const BEARER_STANDALONE = /\b(bearer)\s+([^\s"',}]+)/gi;
const KEY_LIKE = /\b(?:sk-|rk-|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g;
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))\s*=\s*([^\s]+)/g;

function redactText(value: string): string {
  return value
    .replace(JSON_SECRET_FIELD, "$1[redacted]$3")
    .replace(SECRET_PATTERN, "$1$2[redacted]")
    .replace(BEARER_STANDALONE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(KEY_LIKE, "[redacted]")
    .replace(ENV_ASSIGNMENT, "$1=[redacted]");
}

function redactUnknown(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, depth + 1));
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("key") ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("password") ||
      lower.includes("authorization") ||
      lower.includes("credential")
    ) {
      record[key] = "[redacted]";
      continue;
    }
    record[key] = redactUnknown(entry, depth + 1);
  }
  return record;
}

/** Redact secrets from acceptance events. Failures stay visible; only sensitive content is removed. */
export function redactAcceptanceRecord<T>(value: T): T {
  return redactUnknown(value, 0) as T;
}
