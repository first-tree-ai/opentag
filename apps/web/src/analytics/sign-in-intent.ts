const SIGN_IN_INTENT_KEY = "opentag:analytics:sign-in-intent";

/**
 * How long an unspent intent means anything.
 *
 * The redirect providers record theirs on the press, because the press is the last thing that
 * happens in that document — but a press is not a sign-in. Abandon the consent screen, come back
 * later with the session you already had, and a stale intent would report a sign-in that never
 * happened, at the step every ratio in this funnel divides by. Long enough for a consent screen and
 * a second factor; far short of a working day.
 */
const SIGN_IN_INTENT_TTL_MS = 10 * 60 * 1000;

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
    target.sessionStorage.setItem(SIGN_IN_INTENT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
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
    const { method, registering, at } = parsed as { method?: unknown; registering?: unknown; at?: unknown };
    if (typeof method !== "string" || method.length === 0) return undefined;
    // An intent with no timestamp was written by an older build; an expired one describes a press
    // that never became a sign-in. Both are discarded rather than reported.
    if (typeof at !== "number" || Date.now() - at > SIGN_IN_INTENT_TTL_MS) return undefined;
    return { method, registering: registering === true };
  } catch {
    return undefined;
  }
}
