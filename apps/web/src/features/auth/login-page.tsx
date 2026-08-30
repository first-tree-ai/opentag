import { type AuthProvidersResponse, DEFAULT_SIGN_IN_DESTINATION } from "@opentag/shared/browser";
import { browserApi } from "../../api.js";
import googleSignInButton from "../../assets/google-sign-in-light@2x.png";
import { Icon, Text } from "../../ui/design-system.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { PasswordSignInForm } from "./password-sign-in-form.js";

export type AuthProvider = AuthProvidersResponse["providers"][number];

export function LoginPage({ next: requested }: { next?: string }) {
  const providers = useResource(() => browserApi.authProviders(), "auth-providers");
  const next = requested ?? DEFAULT_SIGN_IN_DESTINATION;
  return (
    <main className="grid min-h-screen place-items-center bg-kumo-canvas p-6" data-ui="login-page">
      <section
        aria-labelledby="login-title"
        className="grid w-full max-w-md gap-6 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
        data-ui="login-card"
      >
        <OpenTagBrandLockup />
        <header className="grid gap-1" data-ui="login-copy">
          <Text as="h1" id="login-title" size="lg" variant="heading">
            Welcome back
          </Text>
          <Text as="p" variant="secondary">
            Sign in to continue to OpenTag.
          </Text>
        </header>
        <AsyncState state={providers}>
          {(value) => {
            /*
             * `password` is deliberately excluded here rather than filtered out by the missing `startUrl`: it is a
             * form, so it renders as one instead of as a link to somewhere.
             */
            const linkProviders = value.providers.filter(
              (provider: AuthProvider) => provider.id !== "password" && provider.enabled && provider.startUrl,
            );
            const password = value.providers.some(
              (provider: AuthProvider) => provider.id === "password" && provider.enabled,
            );
            if (linkProviders.length === 0 && !password) {
              return (
                <p className="text-sm text-kumo-subtle" data-ui="login-unavailable" role="status">
                  No sign-in methods are currently available.
                </p>
              );
            }
            return (
              <>
                {password ? <PasswordSignInForm next={next} /> : null}
                {password && linkProviders.length > 0 ? (
                  <p
                    className="flex items-center justify-center gap-2 text-sm text-kumo-subtle"
                    data-ui="login-divider"
                  >
                    <span>or</span>
                  </p>
                ) : null}
                {linkProviders.length > 0 ? (
                  <div className="grid gap-3" data-ui="login-actions">
                    {linkProviders.map((provider: AuthProvider) => (
                      <LoginProviderLink key={provider.id} next={next} provider={provider} />
                    ))}
                  </div>
                ) : null}
              </>
            );
          }}
        </AsyncState>
        <p className="text-sm text-kumo-subtle" data-ui="login-access-note">
          Sign in to manage your Agents and Computers.
        </p>
      </section>
    </main>
  );
}

export function OpenTagBrandLockup() {
  return (
    <div className="flex items-center gap-2 text-lg font-semibold text-kumo-strong" data-ui="login-brand-lockup">
      <span
        className="grid size-8 place-items-center rounded-md bg-kumo-brand text-kumo-inverse"
        data-ui="login-brand-mark"
      >
        <Icon name="shield" />
      </span>
      <span>OpenTag</span>
    </div>
  );
}

export function LoginProviderLink({ next, provider }: { next: string; provider: AuthProvider }) {
  if (!provider.startUrl) return null;
  const google = provider.id === "google";
  const href = `${provider.startUrl}?next=${encodeURIComponent(next)}`;
  if (google) {
    return (
      <a className="block overflow-hidden rounded-md ring ring-kumo-line" data-ui="login-provider-google" href={href}>
        <img alt="Sign in with Google" className="block w-full" src={googleSignInButton} />
      </a>
    );
  }

  return (
    <a
      className="flex min-h-10 items-center justify-center rounded-md bg-kumo-base px-4 py-2 text-sm font-medium text-kumo-default ring ring-kumo-line"
      data-ui="login-provider"
      href={href}
    >
      <span>Continue with {provider.id}</span>
    </a>
  );
}
