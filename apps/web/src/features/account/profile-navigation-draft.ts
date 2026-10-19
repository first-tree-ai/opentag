import * as m from "../../paraglide/messages.js";

const KEY = "opentag.account-profile-navigation-draft";
const MAX_AGE_MS = 30 * 60 * 1000;

export function clearProfileNavigationDraft(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* Storage can be disabled. No stored draft can be read in that case. */
  }
}

/** Restore only this Account's edits against the same confirmed profile, within a short round trip. */
export function readProfileNavigationDraft(accountId: string, confirmedName: string): string {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw || raw.length > 4096) return confirmedName;
    const draft: unknown = JSON.parse(raw);
    if (
      typeof draft !== "object" ||
      draft === null ||
      !("accountId" in draft) ||
      draft.accountId !== accountId ||
      !("confirmedName" in draft) ||
      draft.confirmedName !== confirmedName ||
      !("displayName" in draft) ||
      typeof draft.displayName !== "string" ||
      draft.displayName.length > 255 ||
      !("createdAt" in draft) ||
      typeof draft.createdAt !== "number" ||
      !Number.isFinite(draft.createdAt) ||
      Date.now() - draft.createdAt < 0 ||
      Date.now() - draft.createdAt > MAX_AGE_MS
    )
      return confirmedName;
    return draft.displayName;
  } catch {
    return confirmedName;
  }
}

/** Failure is actionable: never navigate away from edits that the tab cannot retain. */
export function preserveProfileNavigationDraft(accountId: string, confirmedName: string, displayName: string): void {
  if (displayName === confirmedName) {
    clearProfileNavigationDraft();
    return;
  }
  const serialized = JSON.stringify({ accountId, confirmedName, displayName, createdAt: Date.now() });
  try {
    window.sessionStorage.setItem(KEY, serialized);
    if (window.sessionStorage.getItem(KEY) !== serialized) throw new Error("Draft storage verification failed");
  } catch {
    throw new Error(m.account_error_draft_storage());
  }
}
