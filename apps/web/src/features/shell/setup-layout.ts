const STANDALONE_SETUP_ACCOUNT_KEY = "opentag:standalone-setup-account";

/** Keep first-time setup full-screen across an external authorization round trip. */
export function hasStandaloneSetup(accountId: string): boolean {
  try {
    return window.sessionStorage.getItem(STANDALONE_SETUP_ACCOUNT_KEY) === accountId;
  } catch {
    // Storage is optional: React state still pins the current journey's layout.
    return false;
  }
}

export function rememberStandaloneSetup(accountId: string): void {
  try {
    window.sessionStorage.setItem(STANDALONE_SETUP_ACCOUNT_KEY, accountId);
  } catch {
    // Without tab storage, the current layout remains stable until the document reloads.
  }
}

export function clearStandaloneSetup(): void {
  try {
    window.sessionStorage.removeItem(STANDALONE_SETUP_ACCOUNT_KEY);
  } catch {
    // An unavailable layout hint must not prevent navigation or completion of sign-out.
  }
}
