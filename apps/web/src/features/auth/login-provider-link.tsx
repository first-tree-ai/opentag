import googleMark from "../../assets/google-g.png";
import { spaceScriptBoundary } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { buttonClassName } from "../../ui/design-system.js";
import type { AuthProvider } from "./login-page.js";
import { authProviderLabel } from "./provider-label.js";
import "./google-sign-in.css";

export function LoginProviderLink({
  disabled = false,
  next,
  provider,
  registering = false,
}: {
  disabled?: boolean;
  next: string;
  provider: AuthProvider;
  registering?: boolean;
}) {
  if (!provider.startUrl) return null;
  const google = provider.id === "google";
  const href = new URL(provider.startUrl, window.location.origin);
  href.searchParams.set("next", next);
  return (
    // Provider URLs need a document navigation: the server sets OAuth cookies before redirecting.
    <a
      aria-disabled={disabled || undefined}
      className={buttonClassName({
        className: google
          ? "auth-google-link"
          : "flex min-h-11 w-full items-center px-3 text-center text-sm aria-disabled:pointer-events-none aria-disabled:opacity-50 motion-reduce:transition-none",
        variant: google ? "outline" : "secondary",
      })}
      data-ui={google ? "login-provider-google" : "login-provider"}
      href={disabled ? undefined : href.href}
      role={disabled ? "link" : undefined}
      tabIndex={disabled ? -1 : undefined}
    >
      {google ? (
        <>
          <img alt="" className="size-5 shrink-0 object-contain" height={20} src={googleMark} width={20} />
          <span>{registering ? m.auth_sign_up_with_google() : m.auth_sign_in_with_google()}</span>
          <span aria-hidden="true" className="size-5" />
        </>
      ) : (
        <span>{spaceScriptBoundary(m.auth_continue_with_provider({ provider: authProviderLabel(provider.id) }))}</span>
      )}
    </a>
  );
}
