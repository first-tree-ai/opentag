import { DEFAULT_SIGN_IN_DESTINATION, PASSWORD_MIN_LENGTH, resolveSignInDestination } from "@opentag/shared/browser";
import { type FormEvent, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Button, Input } from "../../ui/design-system.js";

/**
 * The email and password form, which both registers and signs in.
 *
 * One form with a mode rather than two routes: the two differ by a single field and a single endpoint, and a separate
 * page would have to re-resolve which providers are available in order to render at all.
 *
 * On success it navigates with a full load rather than a client-side route change. The session and double-submit
 * cookies arrive on that response, and every later request reads the token out of `document.cookie`; re-entering the
 * app through a fresh load is what guarantees it is there before anything tries to use it.
 */
export function PasswordSignInForm({
  navigate = (to: string) => window.location.assign(to),
  next,
}: {
  /** The navigation itself, so a test can observe where a sign-in decided to land rather than following it. */
  navigate?: (to: string) => void;
  next: string;
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const registering = mode === "sign-up";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      if (registering) {
        await browserApi.signUpWithPassword({ email, password, displayName });
      } else {
        await browserApi.signInWithPassword({ email, password });
      }
      /*
       * Re-checked here rather than trusted from the query string. This is the one sign-in method that navigates the
       * browser itself instead of handing its destination to a server route, so without this the same `next` the
       * redirect providers have validated since they existed would be an open redirect on this path alone.
       */
      navigate(resolveSignInDestination(next) ?? DEFAULT_SIGN_IN_DESTINATION);
    } catch (cause) {
      /*
       * The server's message is shown as it is. It is written to be shown — a rejected sign-in says only that the
       * address or password was wrong, so restating it here could only make it less accurate.
       */
      setError(cause instanceof ApiError ? cause.message : m.auth_sign_in_failed());
      setSubmitting(false);
    }
  };

  return (
    <form className="grid gap-4" data-ui="login-password-form" onSubmit={submit}>
      <Input
        label={m.auth_email_label()}
        autoComplete="email"
        id="login-email"
        name="email"
        onChange={(event) => setEmail(event.target.value)}
        required
        type="email"
        value={email}
      />
      {registering ? (
        <Input
          label={m.auth_name_label()}
          autoComplete="name"
          id="login-display-name"
          name="displayName"
          onChange={(event) => setDisplayName(event.target.value)}
          required
          type="text"
          value={displayName}
        />
      ) : null}
      <Input
        label={m.auth_password_label()}
        // Tells a password manager to offer a new secret rather than an existing one, and the reverse on sign-in.
        autoComplete={registering ? "new-password" : "current-password"}
        id="login-password"
        minLength={registering ? PASSWORD_MIN_LENGTH : undefined}
        name="password"
        onChange={(event) => setPassword(event.target.value)}
        required
        type="password"
        value={password}
      />
      {registering ? (
        <p className="text-sm text-kumo-subtle" data-ui="login-password-hint">
          {m.auth_password_min_length({ count: PASSWORD_MIN_LENGTH })}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" data-ui="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={submitting} type="submit">
        {registering ? m.auth_create_account() : m.auth_sign_in()}
      </Button>
      <p className="text-sm text-kumo-subtle" data-ui="login-mode-switch">
        {registering ? m.auth_already_have_account() : m.auth_no_account_yet()}{" "}
        <Button
          variant="inline"
          onClick={() => {
            setMode(registering ? "sign-in" : "sign-up");
            setError(undefined);
          }}
          type="button"
        >
          {registering ? m.auth_sign_in() : m.auth_create_one()}
        </Button>
      </p>
    </form>
  );
}
