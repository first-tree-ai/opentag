export interface AuthTokenIdentity {
  expiresAt: Date;
  userId: string;
}

export interface AuthTokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

/**
 * The credential boundary every login method resolves to, once it knows a stable user id.
 *
 * Better Auth sessions are the only implementation now, but this stays a port rather than a direct dependency: it is
 * what lets `AuthService` be tested without one, and what kept the exchange, refresh, and request paths unchanged when
 * the implementation behind it was replaced.
 */
export interface AuthTokenProvider {
  issuePairForUser(userId: string): Promise<AuthTokenPair>;
  /**
   * Replaces a credential the caller still holds, and withdraws the one it presented.
   *
   * Issuing without withdrawing would leave the previous credential valid until it expired on its own, so revoking
   * what a client currently holds would not lock out a copy taken before its last refresh.
   */
  rotate(token: string, userId: string): Promise<AuthTokenPair>;
  verifyAccess(token: string): Promise<AuthTokenIdentity>;
  verifyRefresh(token: string): Promise<AuthTokenIdentity>;
}
