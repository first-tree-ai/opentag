import type { MCPAuthKind } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, Field, Select } from "../../ui/design-system.js";
import { validAuth } from "./mcp-authorization.js";
import { McpAuthFields } from "./mcp-form.js";
import { mcpOAuthPhaseLabel } from "./mcp-oauth-controls.js";
import type { useMcpSettings } from "./mcp-settings-state.js";

type SettingsState = ReturnType<typeof useMcpSettings>;

function methodLabel(kind: MCPAuthKind): string {
  if (kind === "oauth") return m.mcp_auth_oauth();
  return kind === "bearer" ? m.mcp_auth_token() : m.mcp_auth_none();
}

export function McpPresetAuthentication({ state }: { state: SettingsState }) {
  const { draft, authEdited } = state;
  const key = draft.kind === "bearer";
  const editingKey = key && (authEdited || !state.entry.authorization?.hasCredential);
  return (
    <section className="mcp-preset-authentication" aria-label={m.mcp_auth_label()}>
      <div className="mcp-preset-auth-row">
        <PresetMethod state={state} />
        {!key ? <AccountAction state={state} /> : null}
      </div>
      {key ? <PresetKey state={state} editing={editingKey} /> : null}
      <PresetFeedback state={state} editingKey={editingKey} />
    </section>
  );
}

function PresetKey({ state, editing }: { state: SettingsState; editing: boolean }) {
  const { draft, busy, authEdited } = state;
  return (
    <div className="mcp-preset-key-row">
      {editing ? (
        <McpAuthFields
          draft={draft}
          onChange={state.editAuthentication}
          disabled={busy}
          fixedMethod
          hideKeyLabel
          keyFeedbackId={state.authenticationError ? "mcp-preset-feedback" : undefined}
        />
      ) : (
        <div className="mcp-preset-key-mask text-kumo-subtle">
          <span className="sr-only">{m.mcp_authorize_bearer_label()}</span>
          <span aria-hidden="true">••••••••</span>
        </div>
      )}
      <div className="mcp-preset-key-actions">
        {editing ? (
          <>
            {authEdited ? (
              <Button variant="ghost" disabled={busy} onClick={state.cancel}>
                {m.common_cancel()}
              </Button>
            ) : null}
            <Button type="submit" disabled={busy || !state.configValid || !validAuth(draft)} loading={busy}>
              {m.mcp_auth_save()}
            </Button>
          </>
        ) : (
          <Button
            variant={state.feedback.action === "authorize" || state.authenticationError ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => state.begin("bearer")}
          >
            {m.mcp_auth_update()}
          </Button>
        )}
      </div>
    </div>
  );
}

function PresetMethod({ state }: { state: SettingsState }) {
  if (state.methods.length === 1)
    return (
      <div>
        <span className="mb-2 block text-sm font-medium">{m.mcp_auth_label()}</span>
        <span className="mcp-preset-single-method">{methodLabel(state.draft.kind)}</span>
      </div>
    );
  return (
    <Field className="[&>label]:mb-2" htmlFor="mcp-preset-auth-method" label={m.mcp_auth_label()}>
      <Select<MCPAuthKind>
        id="mcp-preset-auth-method"
        className="w-full"
        aria-label={m.mcp_auth_label()}
        value={state.draft.kind}
        disabled={state.busy}
        itemToStringLabel={(kind) => (kind ? methodLabel(kind) : "")}
        onValueChange={(kind) => {
          if (!kind || kind === state.draft.kind) return;
          if (kind === state.kind) state.cancel();
          else state.begin(kind);
        }}
      >
        {state.methods.map((kind) => (
          <Select.Option key={kind} value={kind}>
            {methodLabel(kind)}
          </Select.Option>
        ))}
      </Select>
    </Field>
  );
}

function AccountAction({ state }: { state: SettingsState }) {
  const session = state.authorization.oauth;
  if (state.draft.kind === "none")
    return state.authEdited ? (
      <Button className="mcp-preset-account-action" type="submit" disabled={state.busy || !state.configValid}>
        {m.mcp_auth_save()}
      </Button>
    ) : null;
  if (session.phase)
    return (
      <Button
        className="mcp-preset-account-action"
        variant="secondary"
        disabled={session.phase === "checking"}
        onClick={() => void session.cancel()}
      >
        {m.common_cancel()}
      </Button>
    );
  const authorize = state.authEdited || !state.entry.authorization?.hasCredential;
  const recovery = authorize || state.feedback.action === "authorize" || Boolean(state.authenticationError);
  return (
    <Button
      className="mcp-preset-account-action"
      variant={recovery ? "primary" : "secondary"}
      disabled={state.busy}
      onClick={() => void state.submit(true)}
    >
      {authorize ? m.mcp_authorize_action() : m.mcp_auth_again()}
    </Button>
  );
}

function PresetFeedback({ state, editingKey }: { state: SettingsState; editingKey: boolean }) {
  const session = state.authorization.oauth;
  const label = feedbackLabel(state, editingKey);
  const neutral = Boolean(session.phase || session.notice || (!state.authenticationError && state.feedback.neutral));
  const retry =
    !session.phase && !editingKey && !state.authEdited && !state.retrying && state.feedback.action === "retry";
  return (
    <div className="mcp-preset-feedback">
      <span
        id="mcp-preset-feedback"
        role={label && !neutral ? "alert" : "status"}
        className={`text-sm ${neutral ? "text-kumo-subtle" : "text-kumo-danger"}`}
      >
        {label}
      </span>
      {session.phase && session.blocked ? (
        <Button variant="inline" size="compact" className="px-0 text-kumo-link" onClick={session.openFallback}>
          {m.mcp_oauth_open_page()}
        </Button>
      ) : null}
      {retry && state.onRetry ? (
        <Button
          variant="inline"
          size="compact"
          className="px-0 text-kumo-link"
          disabled={state.busy}
          onClick={state.onRetry}
        >
          {m.mcp_retry()}
        </Button>
      ) : null}
      {state.authEdited && state.draft.kind === "oauth" && !session.phase ? (
        <Button variant="inline" size="compact" className="px-0 text-kumo-link" onClick={state.cancel}>
          {m.common_cancel()}
        </Button>
      ) : null}
    </div>
  );
}

function feedbackLabel(state: SettingsState, editingKey: boolean): string | undefined {
  const session = state.authorization.oauth;
  if (session.phase) return mcpOAuthPhaseLabel(session);
  if (session.notice) return session.notice;
  if (state.authenticationError) return state.authenticationError;
  if (!editingKey && !state.authEdited) return state.feedback.label;
  return undefined;
}
