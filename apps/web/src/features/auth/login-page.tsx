import {
  type AuthProvidersResponse,
  DEFAULT_SIGN_IN_DESTINATION,
  resolveSignInDestination,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, browserApi, withDeadline } from "../../api.js";
import { getLocale, isLocale, LOCALE_LABELS, locales, setLocale, toLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Empty, Field, Select, SkeletonLine, Text } from "../../ui/design-system.js";
import { OpenTagLogo } from "../../ui/opentag-logo.js";
import { Redirect } from "../navigation/redirect.js";
import { toResourceState } from "../resource/resource-state.js";
import { LoginProviderLink } from "./login-provider-link.js";
import { PasswordSignInForm, type PasswordSignInMode } from "./password-sign-in-form.js";

export type AuthProvider = AuthProvidersResponse["providers"][number];

export function LoginPage({ next: requested }: { next?: string }) {
  const [signedOut, setSignedOut] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const session = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => withDeadline(10_000, () => browserApi.me()),
    enabled: !signedOut,
    // Even offline, attempt the check so a paused query cannot trap the visitor in loading.
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  // Cached Account data must not redirect a visitor before this visit verifies the cookie.
  const verified = session.isFetchedAfterMount;
  const unauthenticated =
    verified && session.isError && session.error instanceof ApiError && session.error.status === 401;
  useEffect(() => {
    // Once the server asks for sign-in, background checks must not discard a form being filled in.
    if (unauthenticated) setSignedOut(true);
  }, [unauthenticated]);
  if (signedOut || unauthenticated) {
    return (
      <LoginFrame disabled={submitting}>
        <LoginForm next={requested} submitting={submitting} onSubmittingChange={setSubmitting} />
      </LoginFrame>
    );
  }

  const failed = verified && session.isError;
  return (
    <LoginFrame>
      {verified && session.isSuccess ? <Redirect href={loginDestination(requested)} replace /> : null}
      <Text as="h1" id="login-title" size="lg" variant="heading">
        {failed ? m.auth_session_check_failed() : m.auth_opening_opentag()}
      </Text>
      {failed ? (
        <div className="grid gap-3" data-ui="login-session-error">
          <Banner description={m.auth_session_check_retry_hint()} role="alert" variant="error" />
          <Button
            className="min-h-11 w-full"
            disabled={session.isFetching}
            loading={session.isFetching}
            onClick={() => void session.refetch()}
            variant="secondary"
          >
            {m.errors_try_again()}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3" data-ui="login-session-loading" role="status">
          <span aria-hidden="true">
            <SkeletonLine className="h-11 w-full motion-reduce:after:animate-none" maxWidth={100} minWidth={100} />
          </span>
          <Text as="p" size="sm" variant="secondary">
            {m.auth_checking_session()}
          </Text>
        </div>
      )}
    </LoginFrame>
  );
}

function loginDestination(requested?: string): string {
  const destination = new URL(
    resolveSignInDestination(requested) ?? DEFAULT_SIGN_IN_DESTINATION,
    window.location.origin,
  );
  // Normalize dot segments before checking again: /agents/../login would otherwise loop.
  const allowed = resolveSignInDestination(destination.pathname + destination.search);
  return destination.pathname === "/login" ? DEFAULT_SIGN_IN_DESTINATION : (allowed ?? DEFAULT_SIGN_IN_DESTINATION);
}

function LoginForm({
  next: requested,
  submitting,
  onSubmittingChange,
}: {
  next?: string;
  submitting: boolean;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const [mode, setMode] = useState<PasswordSignInMode>("sign-in");
  const query = useQuery({
    queryKey: queryKeys.authProviders(),
    queryFn: () => browserApi.authProviders(),
    enabled: !submitting,
  });
  // A reconnect failure must not discard credentials already entered into a usable form.
  const providers = toResourceState(query, (value) => value);
  const next = requested ?? DEFAULT_SIGN_IN_DESTINATION;
  const available = providers.kind === "ready" ? providers.value.providers : [];
  const links = available.filter((provider) => provider.id !== "password" && provider.enabled && provider.startUrl);
  const password = available.some((provider) => provider.id === "password" && provider.enabled);
  const unavailable = providers.kind === "ready" && links.length === 0 && !password;
  const registering = password && mode === "sign-up";

  return (
    <>
      <LoginCardHeading registering={registering} unavailable={unavailable} failed={providers.kind === "error"} />
      {providers.kind === "loading" ? (
        <div className="grid gap-3" data-ui="login-loading" role="status">
          <span aria-hidden="true">
            <SkeletonLine className="h-11 w-full motion-reduce:after:animate-none" maxWidth={100} minWidth={100} />
          </span>
          <Text as="p" size="sm" variant="secondary">
            {m.auth_loading_sign_in_methods()}
          </Text>
        </div>
      ) : null}
      {query.isError ? (
        <div className="grid gap-3" data-ui="login-provider-error">
          <Banner
            description={m.auth_sign_in_methods_retry_hint()}
            role="alert"
            title={m.auth_sign_in_methods_failed()}
            variant="error"
          />
          <Button
            className="min-h-11 w-full"
            disabled={submitting || query.isFetching}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
            variant="secondary"
          >
            {m.errors_try_again()}
          </Button>
        </div>
      ) : null}
      {unavailable ? (
        <div data-ui="login-unavailable" role="status">
          <Empty
            // The enclosing card already owns the surface and primary heading.
            className="items-start gap-2 border-0 bg-transparent p-0 [&>h2]:text-base [&>p]:text-left"
            description={m.auth_contact_administrator()}
            size="sm"
            title={m.auth_no_sign_in_methods_available()}
          />
        </div>
      ) : null}
      {links.length > 0 ? (
        <div className="grid gap-3" data-ui="login-actions">
          {links.map((provider) => (
            <LoginProviderLink
              disabled={submitting}
              key={provider.id}
              next={next}
              provider={provider}
              registering={registering}
            />
          ))}
        </div>
      ) : null}
      {password && links.length > 0 ? (
        <div className="flex items-center gap-3 text-sm text-kumo-subtle" data-ui="login-divider">
          <span aria-hidden="true" className="h-px flex-1 bg-kumo-line" />
          <span>{m.auth_or()}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-kumo-line" />
        </div>
      ) : null}
      {password ? (
        <PasswordSignInForm mode={mode} next={next} onModeChange={setMode} onSubmittingChange={onSubmittingChange} />
      ) : null}
    </>
  );
}

function LoginFrame({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  return (
    <main className="flex min-h-dvh flex-col bg-kumo-canvas" data-ui="login-page" lang={getLocale()}>
      <header className="px-4 pt-6 sm:px-8 sm:pt-8">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
          <OpenTagBrandLockup />
          <LoginLanguageSelect disabled={disabled} />
        </div>
      </header>
      <div className="grid flex-1 place-items-center px-4 py-8 sm:px-8 sm:py-12">
        <section
          aria-labelledby="login-title"
          className="grid w-full min-w-0 max-w-md gap-6 rounded-xl bg-kumo-base p-6 ring ring-kumo-line sm:p-8"
          data-ui="login-card"
        >
          {children}
        </section>
      </div>
    </main>
  );
}

function LoginCardHeading({
  registering,
  unavailable,
  failed,
}: {
  registering: boolean;
  unavailable: boolean;
  failed: boolean;
}) {
  const title = unavailable
    ? m.auth_sign_in_unavailable()
    : registering
      ? m.auth_create_your_account()
      : m.auth_sign_in_to_opentag();
  return (
    <header className="grid gap-2" data-ui="login-copy">
      <Text as="h1" id="login-title" size="lg" variant="heading">
        {title}
      </Text>
      {!unavailable && !failed ? (
        <Text as="p" variant="secondary">
          {registering ? m.auth_create_account_description() : m.auth_manage_agents_and_computers()}
        </Text>
      ) : null}
    </header>
  );
}

function LoginLanguageSelect({ disabled }: { disabled: boolean }) {
  return (
    <Field hideLabel htmlFor="login-language" label={m.account_language_label()}>
      <Select
        className="min-h-11 focus:ring-kumo-focus"
        disabled={disabled}
        id="login-language"
        renderValue={(locale) => LOCALE_LABELS[locale]}
        value={getLocale()}
        onValueChange={(value) => {
          const locale = toLocale(value);
          if (locale && isLocale(locale)) setLocale(locale);
        }}
      >
        {locales.map((locale) => (
          <Select.Option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </Select.Option>
        ))}
      </Select>
    </Field>
  );
}

export function OpenTagBrandLockup() {
  return (
    <div className="flex items-center" data-ui="login-brand-lockup">
      <OpenTagLogo label={m.auth_brand_name()} />
    </div>
  );
}
