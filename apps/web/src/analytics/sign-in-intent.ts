const SIGN_IN_INTENT_KEY = "opentag:analytics:sign-in-intent";

export interface SignInIntent {
  /** How the Account signed in: `password`, or the identity provider's id. */
  readonly method: string;
  /** Whether the press that started this was "create an account" rather than "sign in". */
  readonly registering: boolean;
}

/**
 * Carries how someone signed in across the load that signs them in.
 *
 * Neither sign-in path can report its own success. The password form navigates the browser itself
 * once the session cookie arrives, so an event raised beside that call races the unload; the
 * identity providers leave the application entirely on a plain link and come back through a Server
 * redirect that carries no marker at all. Both do, however, know the method *before* they leave.
 *
 * So the method is written down here on the way out and read once on the way back in, where the
 * Account has actually been resolved. Session storage is what makes that reliable: it is scoped to
 * the one tab that is signing in, and it survives the OAuth round trip that a variable in memory
 * would not. Reading consumes it, so a re-render — or React's development-mode second pass — finds
 * nothing and reports nothing.
 */
export function rememberSignInIntent(intent: SignInIntent, target: Window = window): void {
  try {
    target.sessionStorage.setItem(SIGN_IN_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // A browser that refuses storage still signs in. The sign-in goes unreported, which is the
    // correct outcome for a signal that exists only to describe it.
  }
}

export function takeSignInIntent(target: Window = window): SignInIntent | undefined {
  try {
    const raw = target.sessionStorage.getItem(SIGN_IN_INTENT_KEY);
    target.sessionStorage.removeItem(SIGN_IN_INTENT_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { method, registering } = parsed as { method?: unknown; registering?: unknown };
    if (typeof method !== "string" || method.length === 0) return undefined;
    return { method, registering: registering === true };
  } catch {
    return undefined;
  }
}
