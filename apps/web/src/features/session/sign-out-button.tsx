import { hasBrowserSession } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Button } from "../../ui/design-system.js";
import { useAccount } from "./session-context.js";
import { type SignOutState, useContextFreeSignOut, useSignOut } from "./use-sign-out.js";

/** The sign-out control itself. It owns no session logic, so any context can supply the state. */
export function SignOutControl({ error, signOut, signingOut }: SignOutState) {
  return (
    <div className="flex flex-col items-end gap-1" data-ui="sign-out">
      <Button disabled={signingOut} loading={signingOut} onClick={() => void signOut()} variant="ghost">
        {signingOut ? m.shell_signing_out() : m.shell_sign_out()}
      </Button>
      {error ? (
        <span className="max-w-64 text-right text-sm text-kumo-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Account display name plus sign-out, for full-screen states that have no shell around them. */
export function AccountSignOut() {
  const { me } = useAccount();
  const state = useSignOut();
  return (
    <div className="flex items-start gap-2" data-ui="account-sign-out">
      <span className="hidden max-w-40 truncate py-1.5 text-sm text-kumo-subtle sm:inline">{me.user.displayName}</span>
      <SignOutControl {...state} />
    </div>
  );
}

/**
 * Sign-out that needs no Router or Account context, for error and not-found pages.
 * These pages also serve signed-out visitors, for whom the Server would refuse the logout (no CSRF cookie),
 * so the control is offered only when a session is evident.
 */
export function ContextFreeSignOut() {
  const state = useContextFreeSignOut();
  return hasBrowserSession() ? <SignOutControl {...state} /> : null;
}
