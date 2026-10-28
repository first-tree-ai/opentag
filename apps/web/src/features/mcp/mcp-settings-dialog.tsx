import { MCPServerUrlSchema } from "@opentag/shared/browser";
import { useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl, Loader } from "../../ui/design-system.js";
import { validAuth } from "./mcp-authorization.js";
import { McpConfigurationFields } from "./mcp-configuration-fields.js";
import { McpDialogTitle } from "./mcp-dialog-title.js";
import { McpAuthFields } from "./mcp-form.js";
import { McpOAuthControls } from "./mcp-oauth-controls.js";
import { McpPresetAuthentication } from "./mcp-preset-authentication.js";
import { useMcpSettings } from "./mcp-settings-state.js";
import { mcpTitle } from "./mcp-title.js";

type SettingsState = ReturnType<typeof useMcpSettings>;

export function McpSettingsDialog(props: Parameters<typeof useMcpSettings>[0]) {
  const state = useMcpSettings(props);
  const { entry, preset, busy, config, setConfig, draft, authEdited, error } = state;
  const [addressTouched, setAddressTouched] = useState(false);
  const addressInvalid = addressTouched && !MCPServerUrlSchema.safeParse(config.url).success;
  return (
    <Dialog
      className={`mcp-form-dialog mcp-settings-dialog ${preset ? "mcp-preset-dialog" : ""}`}
      title={<McpDialogTitle entry={entry} title={mcpTitle(entry)} />}
      closeLabel={m.common_close_title({ title: mcpTitle(entry) })}
      busy={busy && !state.authorization.oauth.phase}
      onClose={props.onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void state.submit();
        }}
      >
        <div className="mcp-settings-body mcp-fields">
          {!preset ? (
            <div className="grid gap-2">
              <Field htmlFor="mcp-settings-url" label={m.mcp_settings_address()}>
                <KumoInputControl
                  id="mcp-settings-url"
                  aria-label={m.mcp_settings_address()}
                  value={config.url}
                  disabled={busy}
                  aria-invalid={addressInvalid}
                  aria-describedby={addressInvalid ? "mcp-settings-url-error" : undefined}
                  onBlur={() => setAddressTouched(true)}
                  onChange={(event) => setConfig({ ...config, url: event.target.value })}
                />
              </Field>
              {addressInvalid ? (
                <p id="mcp-settings-url-error" role="alert" className="text-sm text-kumo-danger">
                  {m.mcp_add_url_error()}
                </p>
              ) : null}
            </div>
          ) : null}
          <AuthenticationSection state={state} />
          {preset ? <PresetAddress url={authEdited ? config.url : entry.effective.url} /> : null}
          {!preset ? (
            <fieldset disabled={busy} className="min-w-0 m-0 border-0 p-0">
              <McpConfigurationFields draft={config} kind={draft.kind} onChange={setConfig} address={false} />
            </fieldset>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-kumo-danger">
              {error}
            </p>
          ) : null}
        </div>
        <CustomSettingsFooter state={state} />
      </form>
    </Dialog>
  );
}

function CustomSettingsFooter({ state }: { state: SettingsState }) {
  const { preset, dirty, authEdited, authorization, busy, configValid, draft, config } = state;
  if (preset || (!dirty && !authEdited) || authorization.oauth.phase) return null;
  const valid =
    configValid &&
    (!authEdited || validAuth({ ...draft, authHeader: config.authHeader, authScheme: config.authScheme }));
  const label = busy
    ? m.mcp_saving()
    : authEdited && draft.kind === "oauth"
      ? m.mcp_authorize_action()
      : m.mcp_edit_submit();
  return (
    <footer className="mcp-settings-footer">
      <Button variant="ghost" disabled={busy} onClick={state.cancel}>
        {m.common_cancel()}
      </Button>
      <Button type="submit" disabled={busy || !valid} loading={busy}>
        {label}
      </Button>
    </footer>
  );
}

function PresetAddress({ url }: { url: string }) {
  const [copiedUrl, setCopiedUrl] = useState<string>();
  const copied = copiedUrl === url;
  return (
    <section className="mcp-preset-address" aria-label={m.mcp_settings_address()}>
      <span className="text-xs text-kumo-subtle">{m.mcp_settings_address()}</span>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 select-text text-sm text-kumo-subtle">{url}</span>
        <Button
          variant="ghost"
          shape="square"
          aria-label={copied ? m.common_copied() : m.common_copy()}
          onClick={() => {
            void navigator.clipboard
              .writeText(url)
              .then(() => setCopiedUrl(url))
              .catch(() => setCopiedUrl(undefined));
          }}
        >
          <Icon name={copied ? "check" : "copy"} />
        </Button>
      </div>
    </section>
  );
}

function AuthenticationSection({ state }: { state: SettingsState }) {
  if (!state.authenticationReady) return <AuthenticationLoading state={state} />;
  if (state.preset) return <McpPresetAuthentication state={state} />;
  const { authEdited, authorization } = state;
  return (
    <section className="grid gap-3" aria-label={m.mcp_auth_label()}>
      <CustomAuthentication state={state} />
      {authEdited ? <AuthenticationFeedback state={state} /> : null}
      <McpOAuthControls session={authorization.oauth} />
      {!authEdited && !authorization.oauth.phase ? <CurrentAuthentication state={state} /> : null}
    </section>
  );
}

function AuthenticationFeedback({ state, recovery = false }: { state: SettingsState; recovery?: boolean }) {
  const { authEdited, error, authenticationError, authorization, feedback } = state;
  const label = authenticationError ?? (authEdited ? undefined : feedback.label);
  if (error || authorization.oauth.phase || !label) return null;
  if (!authenticationError && feedback.action === "retry" && state.onRetry && !recovery) return null;
  return (
    <p
      role={authenticationError ? "alert" : undefined}
      className={`mcp-auth-feedback text-sm ${!authenticationError && feedback.neutral ? "text-kumo-subtle" : "text-kumo-danger"}`}
    >
      {label}
    </p>
  );
}

function AuthenticationLoading({ state }: { state: SettingsState }) {
  return (
    <div className="grid gap-3">
      <span className="text-sm font-medium">{m.mcp_auth_label()}</span>
      {state.authenticationLoadFailed ? (
        <div className="flex items-center gap-3 text-sm">
          <span role="alert" className="text-kumo-danger">
            {m.common_request_failed()}
          </span>
          <Button variant="ghost" size="compact" onClick={state.retryAuthentication}>
            {m.mcp_retry()}
          </Button>
        </div>
      ) : (
        <Loader size="sm" />
      )}
    </div>
  );
}

function CustomAuthentication({ state }: { state: SettingsState }) {
  return (
    <McpAuthFields
      label={m.mcp_auth_label()}
      disabled={state.busy}
      draft={state.draft}
      hideKey={
        state.draft.kind !== "bearer" || (!state.authEdited && state.entry.authorization?.hasCredential === true)
      }
      onChange={state.editAuthentication}
    />
  );
}

function CurrentAuthentication({ state }: { state: SettingsState }) {
  const { entry, kind, busy, begin, submit } = state;
  return (
    <>
      {kind === "bearer" && entry.authorization?.hasCredential ? (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-kumo-subtle">••••••••</span>
            <Button variant="ghost" disabled={busy} onClick={() => begin("bearer")}>
              {m.mcp_auth_update()}
            </Button>
          </div>
          <AuthenticationFeedback state={state} />
        </div>
      ) : null}
      {kind === "oauth" || (kind === "bearer" && !entry.authorization?.hasCredential) ? (
        <div className="mcp-auth-action-row">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => (kind === "oauth" ? void submit(true) : begin("bearer"))}
          >
            {kind === "oauth" && entry.authorization?.hasCredential ? m.mcp_auth_again() : m.mcp_authorize_action()}
          </Button>
          <AuthenticationFeedback state={state} />
        </div>
      ) : null}
      {kind === "none" ? <AuthenticationFeedback state={state} /> : null}
      <ProbeRecovery state={state} />
    </>
  );
}

function ProbeRecovery({ state }: { state: SettingsState }) {
  if (state.feedback.action !== "retry" || !state.onRetry) return null;
  return (
    <div className="mcp-auth-action-row">
      <Button variant="secondary" size="compact" disabled={state.busy} loading={state.retrying} onClick={state.onRetry}>
        {m.mcp_retry()}
      </Button>
      <AuthenticationFeedback state={state} recovery />
    </div>
  );
}
