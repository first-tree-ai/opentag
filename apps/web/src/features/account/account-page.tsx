import type { MeResponse } from "@opentag/shared/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { Button, Field, KumoInputControl, SettingsList, SettingsRow, Text } from "../../ui/design-system.js";
import { Page } from "../layout/page.js";
import { useAccount } from "../session/session-context.js";

export function AccountPage() {
  const { me, refreshMe } = useAccount();
  return (
    <Page title="Account" description="Manage your personal account details.">
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
      setError(cause instanceof Error ? cause.message : "Unable to save the account profile");
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
      setMessage("Account profile saved.");
    } catch {
      setUnsyncedDisplayName(savedDisplayName);
      setMessage(undefined);
      setError(
        "Your display name was saved. OpenTag could not refresh the account, so the rest of the page still shows the previous name.",
      );
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
        Account profile
      </Text>
      <SettingsList>
        <SettingsRow label="Email" description="Your sign-in email cannot be changed here.">
          <Field hint="Read only" hintId="account-email-hint" htmlFor="account-email" label="Email">
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
        <SettingsRow label="Display name" description="This identity is used throughout OpenTag.">
          <Field htmlFor="account-display-name" label="Display name">
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
      </SettingsList>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">Unsaved changes</span>
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
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save account profile"}
            </Button>
          </div>
        </div>
      ) : null}
      {!dirty && unsyncedDisplayName !== undefined ? (
        // The value is saved, so this offers only the step that failed: no Save that would repeat
        // the write, and no Discard that would replace the saved name with the stale projection.
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">Account not refreshed</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={syncing} onClick={() => void retrySync()}>
              {syncing ? "Refreshing…" : "Retry refresh"}
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
