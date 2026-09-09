import {
  DEFAULT_SIGN_IN_DESTINATION,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  resolveSignInDestination,
} from "@opentag/shared/browser";
import { type FormEvent, useRef, useState } from "react";
import { rememberSignInIntent } from "../../analytics/sign-in-intent.js";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Field, Icon, Input } from "../../ui/design-system.js";

export type PasswordSignInMode = "sign-in" | "sign-up";

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
  mode: controlledMode,
  onModeChange,
  onSubmittingChange,
}: {
  /** The navigation itself, so a test can observe where a sign-in decided to land rather than following it. */
  navigate?: (to: string) => void;
  next: string;
  mode?: PasswordSignInMode;
  onModeChange?: (mode: PasswordSignInMode) => void;
  onSubmittingChange?: (submitting: boolean) => void;
}) {
  const [localMode, setLocalMode] = useState<PasswordSignInMode>("sign-in");
  const mode = controlledMode ?? localMode;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const inFlight = useRef(false);
  const registering = mode === "sign-up";
  const idleLabel = registering ? m.auth_create_account() : m.auth_sign_in();
  const pendingLabel = registering ? m.auth_creating_account() : m.auth_signing_in();
  const submitLabel = submitting ? pendingLabel : idleLabel;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      if (registering) {
        await browserApi.signUpWithPassword({ email, password, displayName });
      } else {
        await browserApi.signInWithPassword({ email, password });
      }
      // Recorded rather than reported: the navigation below replaces this document, so the
      // sign-in is reported by the page it lands on, which is also the page that knows who it is.
      rememberSignInIntent({ method: "password", registering });
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
      inFlight.current = false;
      onSubmittingChange?.(false);
    }
  };

  return (
    <form aria-busy={submitting} className="grid gap-5" data-ui="login-password-form" onSubmit={submit}>
      {registering ? (
        <Input
          label={m.auth_name_label()}
          autoComplete="name"
          className="min-h-11 focus:ring-kumo-focus"
          disabled={submitting}
          id="login-display-name"
          name="displayName"
          onChange={(event) => setDisplayName(event.target.value)}
          required
          type="text"
          value={displayName}
        />
      ) : null}
      <Input
        label={m.auth_email_label()}
        autoCapitalize="none"
        autoComplete="email"
        className="min-h-11 focus:ring-kumo-focus"
        disabled={submitting}
        id="login-email"
        name="email"
        onChange={(event) => setEmail(event.target.value)}
        required
        spellCheck={false}
        type="email"
        value={email}
      />
      <Field
        hint={registering ? m.auth_password_min_length({ count: PASSWORD_MIN_LENGTH }) : undefined}
        hintId="login-password-hint"
        htmlFor="login-password"
        label={m.auth_password_label()}
      >
        <div className="relative">
          <Input
            aria-describedby={registering ? "login-password-hint" : undefined}
            aria-labelledby="login-password-label"
            // Let password managers distinguish an existing credential from a new one.
            autoCapitalize="none"
            autoComplete={registering ? "new-password" : "current-password"}
            className="min-h-11 w-full pr-12 focus:ring-kumo-focus"
            disabled={submitting}
            id="login-password"
            maxLength={PASSWORD_MAX_LENGTH}
            minLength={registering ? PASSWORD_MIN_LENGTH : undefined}
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            spellCheck={false}
            type={showPassword ? "text" : "password"}
            value={password}
          />
          <Button
            aria-controls="login-password"
            aria-label={showPassword ? m.auth_hide_password() : m.auth_show_password()}
            aria-pressed={showPassword}
            className="absolute top-0 right-0 min-h-11 min-w-11 motion-reduce:transition-none"
            disabled={submitting}
            onClick={() => setShowPassword(!showPassword)}
            shape="square"
            type="button"
            variant="ghost"
          >
            <Icon name={showPassword ? "eye-slash" : "eye"} />
          </Button>
        </div>
      </Field>
      {error ? <Banner data-ui="login-error" description={error} role="alert" size="sm" variant="error" /> : null}
      <Button
        aria-label={submitLabel}
        className="min-h-11 w-full motion-reduce:transition-none"
        disabled={submitting}
        loading={submitting}
        type="submit"
      >
        {submitLabel}
      </Button>
      <p
        className="flex flex-wrap items-center justify-center gap-x-1 text-center text-sm text-kumo-subtle"
        data-ui="login-mode-switch"
      >
        <span>{registering ? m.auth_already_have_account() : m.auth_no_account_yet()}</span>
        <Button
          className="min-h-11 text-kumo-link motion-reduce:transition-none"
          disabled={submitting}
          variant="inline"
          onClick={() => {
            const nextMode = registering ? "sign-in" : "sign-up";
            setLocalMode(nextMode);
            onModeChange?.(nextMode);
            setShowPassword(false);
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
