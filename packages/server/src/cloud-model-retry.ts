import { setTimeout } from "node:timers/promises";

export function cloudModelRetryDelay(retryAfter: string | undefined, retries: number): number | undefined {
  if (retries >= 3) return undefined;
  if (retryAfter !== undefined) {
    const delay = Number(retryAfter) * 1_000;
    return Number.isFinite(delay) && delay >= 0 && delay <= 60_000 ? delay : undefined;
  }
  return 500 * 2 ** retries * (1 - Math.random() * 0.25);
}

export async function waitForCloudModelRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  try {
    await setTimeout(delayMs, undefined, { signal });
    return true;
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  }
}

export function cloudModelRetryAfter(value: string | null, now = Date.now()): string | undefined {
  if (value === null) return undefined;
  const hint = value.trim();
  if (hint.length === 0 || hint.length > 128) return undefined;
  if (/^\d+$/.test(hint)) return hint;
  const timestamp = Date.parse(hint);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== hint) return undefined;
  return String(Math.max(0, Math.ceil((timestamp - now) / 1_000)));
}
