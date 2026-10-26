const PREFIX = "opentag.checkout-return:";
const MAX_AGE_MS = 30 * 60 * 1000;

/** A tab-local reminder only; it never establishes whether a payment succeeded. */
export function rememberCheckoutReturn(accountId: string): void {
  try {
    window.sessionStorage.setItem(`${PREFIX}${accountId}`, String(Date.now()));
  } catch {
    // Optional feedback must not prevent checkout when browser storage is unavailable.
  }
}

export function hasCheckoutReturn(accountId: string): boolean {
  try {
    const stored = window.sessionStorage.getItem(`${PREFIX}${accountId}`);
    if (!stored) return false;
    const age = Date.now() - Number(stored);
    return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function dismissCheckoutReturn(accountId: string): void {
  try {
    window.sessionStorage.removeItem(`${PREFIX}${accountId}`);
  } catch {
    // The mounted notice is still dismissed when browser storage is unavailable.
  }
}
