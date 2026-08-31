const REBOARD_REVIEW_ACCOUNT_KEY = "opentag:staging-reboard-review-account";

/** Keeps a staging Re-board inspectable even when the browser reloads the onboarding route. */
export function rememberReboardReview(accountId: string): void {
  window.sessionStorage.setItem(REBOARD_REVIEW_ACCOUNT_KEY, accountId);
}

/** Reset all and a successfully finished review both retire the tab-scoped review intent. */
export function forgetReboardReview(): void {
  window.sessionStorage.removeItem(REBOARD_REVIEW_ACCOUNT_KEY);
}

/** The marker is Account-scoped so signing into another Account in the same tab cannot inherit it. */
export function isReboardReviewFor(accountId: string): boolean {
  return window.sessionStorage.getItem(REBOARD_REVIEW_ACCOUNT_KEY) === accountId;
}
