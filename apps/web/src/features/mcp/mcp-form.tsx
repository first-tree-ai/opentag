import type { ReactNode } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Collapsible, Field, Icon, KumoInputControl, Radio } from "../../ui/design-system.js";
import { type AuthDraft, type HeaderMode, type HeaderRow, newHeader, validHeaders } from "./mcp-form-model.js";
import "./mcp.css";

export function McpFooter({
  onClose,
  busy = false,
  children,
}: {
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <footer className="mt-6 flex flex-wrap items-center justify-end gap-2">
      <Button disabled={busy} variant="ghost" onClick={onClose}>
        {m.common_cancel()}
      </Button>
      {children}
    </footer>
  );
}
export function McpDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible.Root className="mcp-disclosure min-w-0 border-t border-kumo-line">
      <Collapsible.Trigger render={<Button className="mcp-disclosure-trigger" variant="ghost" />}>
        {label}
        <Icon className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-180" name="chevron-down" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="min-w-0 pb-2 pt-2">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}
export function McpHeaders({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  return (
    <div className="grid min-w-0 gap-3">
      {rows.map((row) => (
        <div className="mcp-header-row" key={row.id}>
          <KumoInputControl
            aria-label={m.mcp_edit_header_name()}
            placeholder={m.mcp_edit_header_name()}
            value={row.name}
            onChange={(event) =>
              onChange(rows.map((item) => (item.id === row.id ? { ...item, name: event.target.value } : item)))
            }
          />
          <KumoInputControl
            aria-label={m.mcp_edit_header_value()}
            placeholder={m.mcp_edit_header_value()}
            value={row.value}
            onChange={(event) =>
              onChange(rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)))
            }
          />
          <Button
            aria-label={m.mcp_edit_header_remove()}
            shape="square"
            size="compact"
            variant="ghost"
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
          >
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <div>
        <Button size="compact" variant="secondary" onClick={() => onChange([...rows, newHeader()])}>
          <Icon name="plus" />
          {m.mcp_edit_header_add()}
        </Button>
      </div>
    </div>
  );
}
export function McpHeaderMode({ value, onChange }: { value: HeaderMode; onChange: (mode: HeaderMode) => void }) {
  return (
    <fieldset className="mcp-radio">
      <legend>{m.mcp_edit_advanced()}</legend>
      <Radio.Group value={value} onValueChange={(value) => onChange(value as HeaderMode)}>
        <Radio.Item value="inherit" label={m.mcp_headers_inherit()} />
        <Radio.Item value="custom" label={m.mcp_headers_custom()} />
        <Radio.Item value="none" label={m.mcp_edit_empty_extra_headers()} />
      </Radio.Group>
    </fieldset>
  );
}
export function McpTokenSettings({
  header,
  prefix,
  onHeader,
  onPrefix,
}: {
  header: string;
  prefix: string;
  onHeader: (value: string) => void;
  onPrefix: (value: string) => void;
}) {
  return (
    <div className="mcp-token-fields">
      <Field htmlFor="mcp-auth-header" label={m.mcp_edit_auth_header_label()}>
        <KumoInputControl id="mcp-auth-header" value={header} onChange={(event) => onHeader(event.target.value)} />
      </Field>
      <Field htmlFor="mcp-auth-scheme" label={m.mcp_edit_auth_scheme_label()} hint={m.mcp_edit_auth_scheme_help()}>
        <KumoInputControl id="mcp-auth-scheme" value={prefix} onChange={(event) => onPrefix(event.target.value)} />
      </Field>
    </div>
  );
}
export function McpAuthFields({
  draft,
  onChange,
  existing = false,
}: {
  draft: AuthDraft;
  onChange: (draft: AuthDraft) => void;
  existing?: boolean;
}) {
  const help =
    draft.kind === "oauth"
      ? m.mcp_authorize_oauth_description()
      : draft.kind === "bearer"
        ? m.mcp_authorize_bearer_description()
        : m.mcp_authorize_none_description();
  return (
    <>
      <div>
        <fieldset className="mcp-radio">
          <legend>{m.mcp_auth_label()}</legend>
          <p className="mb-3 text-xs leading-relaxed text-kumo-subtle">{m.mcp_auth_help()}</p>
          <Radio.Group
            value={draft.kind}
            onValueChange={(kind) => onChange({ ...draft, kind: kind as AuthDraft["kind"] })}
          >
            <Radio.Item value="oauth" label={m.mcp_auth_oauth()} />
            <Radio.Item value="bearer" label={m.mcp_auth_token()} />
            <Radio.Item value="none" label={m.mcp_auth_none()} />
          </Radio.Group>
        </fieldset>
        <p className="mt-3 text-xs leading-relaxed text-kumo-subtle">{help}</p>
      </div>
      {draft.kind === "bearer" ? (
        <Field htmlFor="mcp-bearer-key" label={m.mcp_authorize_bearer_label()}>
          <KumoInputControl
            id="mcp-bearer-key"
            type="password"
            autoComplete="off"
            value={draft.token}
            onChange={(event) => onChange({ ...draft, token: event.target.value })}
          />
        </Field>
      ) : null}
      <McpDisclosure label={m.mcp_advanced()}>
        <div className="grid gap-4">
          {draft.kind === "bearer" ? (
            <McpTokenSettings
              header={draft.authHeader}
              prefix={draft.authScheme}
              onHeader={(authHeader) => onChange({ ...draft, authHeader })}
              onPrefix={(authScheme) => onChange({ ...draft, authScheme })}
            />
          ) : null}
          {existing ? (
            <McpHeaderMode value={draft.headerMode} onChange={(headerMode) => onChange({ ...draft, headerMode })} />
          ) : (
            <span className="text-sm font-medium">{m.mcp_edit_advanced()}</span>
          )}
          {!existing || draft.headerMode === "custom" ? (
            <>
              <McpHeaders rows={draft.headers} onChange={(headers) => onChange({ ...draft, headers })} />
              {!validHeaders(draft.headers, draft.authHeader) ? (
                <p className="text-xs text-kumo-danger">{m.mcp_headers_invalid()}</p>
              ) : null}
            </>
          ) : null}
        </div>
      </McpDisclosure>
    </>
  );
}

export function McpHelp({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible.Root className={`min-w-0 text-xs text-kumo-subtle ${className}`}>
      <Collapsible.Trigger render={<Button className="mcp-help-trigger" variant="ghost" size="compact" />}>
        {label}
        <Icon name="chevron-down" className="size-3 transition-transform [[data-panel-open]_&]:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-2 max-w-prose leading-relaxed">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}
