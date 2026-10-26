export function cloudModelRetryAfter(value: string | null, now = Date.now()): string | undefined {
  if (value === null) return undefined;
  const hint = value.trim();
  if (hint.length === 0 || hint.length > 128) return undefined;
  if (/^\d+$/.test(hint)) return hint;
  const timestamp = Date.parse(hint);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== hint) return undefined;
  return String(Math.max(0, Math.ceil((timestamp - now) / 1_000)));
}
