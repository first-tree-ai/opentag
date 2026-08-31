import type { MeResponse } from "@opentag/shared/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { getLocale, isLocale, LOCALE_LABELS, locales, setLocale, toLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";
import { Button, Field, KumoInputControl, Select, SettingsList, SettingsRow, Text } from "../../ui/design-system.js";
import { Page } from "../layout/page.js";
import { useAccount } from "../session/session-context.js";

export function AccountPage() {
  const { me, refreshMe } = useAccount();
  return (
    <Page title={m.account_page_title()} description={m.account_page_description()}>
      <AccountSettings refreshMe={refreshMe} user={me.user} />
    </Page>
  );
}

export function AccountSettings({
  refreshMe,
  user,
}: {
  refreshMe: () => Promise<MeResponse>;
  user: MeResponse["user"];
}) {
  const saveInFlight = useRef(false);
  const confirmedDisplayNameRef = useRef(user.displayName);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const syncInFlight = useRef(false);
  const [syncing, setSyncing] = useState(false);
  /**
   * A Server-confirmed display name whose Account refresh has not succeeded yet. It is saved, not
   * unsaved, so it — and never the stale projection — is what the form treats as confirmed.
   */
  const [unsyncedDisplayName, setUnsyncedDisplayName] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const confirmedDisplayName = unsyncedDisplayName ?? user.displayName;
  const dirty = displayName !== confirmedDisplayName;

  useEffect(() => {
    if (confirmedDisplayNameRef.current === user.displayName) return;
    confirmedDisplayNameRef.current = user.displayName;
    setDisplayName(user.displayName);
  }, [user.displayName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in the text field submits this form too, so the boundary lives here rather than in
    // which controls are rendered: a committed save must not be repeated, and a save must never
    // run against an Account refresh that is still in flight.
    if (saveInFlight.current || syncInFlight.current || !dirty) return;
    saveInFlight.current = true;
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const updated = await browserApi.updateProfile({ displayName });
      setDisplayName(updated.displayName);
      await syncAccount(updated.displayName);
    } catch (cause) {
      // Only the write can fail here; syncAccount reports its own failure. Fall back to the last
      // confirmed value, which is the saved one when an earlier save is still unsynchronized.
      setDisplayName(confirmedDisplayName);
      setError(cause instanceof Error ? cause.message : m.account_error_profile_save_failed());
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  /**
   * Refreshes the shared Account after a committed write; it never repeats the write itself. One
   * refresh at a time, so a slower earlier response can never overwrite a newer projection.
   */
  async function syncAccount(savedDisplayName: string): Promise<void> {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      await refreshMe();
      setUnsyncedDisplayName(undefined);
      setError(undefined);
      setMessage(m.account_profile_saved());
    } catch {
      setUnsyncedDisplayName(savedDisplayName);
      setMessage(undefined);
      setError(m.account_error_refresh_failed());
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }

  async function retrySync() {
    if (unsyncedDisplayName === undefined) return;
    await syncAccount(unsyncedDisplayName);
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Text as="h2" variant="heading">
        {m.account_profile_title()}
      </Text>
      <SettingsList>
        <SettingsRow label={m.account_email()} description={m.account_email_description()}>
          <Field
            hint={m.account_hint_read_only()}
            hintId="account-email-hint"
            htmlFor="account-email"
            label={m.account_email()}
          >
            <KumoInputControl
              aria-describedby="account-email-hint"
              id="account-email"
              name="email"
              readOnly
              type="email"
              value={user.email}
            />
          </Field>
        </SettingsRow>
        <SettingsRow label={m.account_display_name()} description={m.account_display_name_description()}>
          <Field htmlFor="account-display-name" label={m.account_display_name()}>
            <KumoInputControl
              autoComplete="name"
              // Editing during a refresh-only retry could open a save that races it.
              disabled={syncing}
              id="account-display-name"
              maxLength={255}
              name="displayName"
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
                setMessage(undefined);
                setError(undefined);
              }}
              required
              value={displayName}
            />
          </Field>
        </SettingsRow>
        <SettingsRow label={m.account_language_label()} description={m.account_language_description()}>
          <Field htmlFor="account-language" label={m.account_language_label()}>
            <Select
              aria-label={m.account_language_label()}
              id="account-language"
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
        </SettingsRow>
      </SettingsList>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">{m.account_unsaved_changes()}</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(confirmedDisplayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              {m.account_discard()}
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? m.account_saving() : m.account_save_profile()}
            </Button>
          </div>
        </div>
      ) : null}
      {!dirty && unsyncedDisplayName !== undefined ? (
        // The value is saved, so this offers only the step that failed: no Save that would repeat
        // the write, and no Discard that would replace the saved name with the stale projection.
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">{m.account_account_not_refreshed()}</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={syncing} onClick={() => void retrySync()}>
              {syncing ? m.account_refreshing() : m.account_retry_refresh()}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="text-sm text-kumo-success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
