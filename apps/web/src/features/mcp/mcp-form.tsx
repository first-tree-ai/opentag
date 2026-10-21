import { type ReactNode, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Collapsible, Field, Icon, KumoInputControl, Radio } from "../../ui/design-system.js";
import { type AuthDraft, type HeaderRow, newHeader } from "./mcp-form-model.js";
import "./mcp.css";

export function McpFooter({
  onClose,
  busy = false,
  children,
}: {
  onClose: () => void;
  busy?: boolean;
  /** The step's primary action. A step that carries its own submit control omits it. */
  children?: ReactNode;
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
export function McpDisclosure({
  label,
  children,
  bordered = true,
  open,
  onOpenChange,
}: {
  label: string;
  children: ReactNode;
  bordered?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      className={`mcp-disclosure min-w-0 ${bordered ? "border-t border-kumo-line" : ""}`}
    >
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
export function McpAuthFields({
  draft,
  onChange,
  label = m.mcp_auth_label(),
  variant = "setup",
  fixedMethod = false,
  hideKey = false,
  hideKeyLabel = false,
  keyFeedbackId,
  disabled = false,
}: {
  draft: AuthDraft;
  onChange: (draft: AuthDraft) => void;
  label?: string;
  variant?: "setup" | "settings";
  fixedMethod?: boolean;
  hideKey?: boolean;
  hideKeyLabel?: boolean;
  keyFeedbackId?: string;
  disabled?: boolean;
}) {
  if (fixedMethod)
    return !hideKey && draft.kind === "bearer" ? (
      <McpKeyField
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        hideLabel={hideKeyLabel}
        feedbackId={keyFeedbackId}
      />
    ) : null;
  const choiceClass = variant === "settings" ? "mcp-auth-choice" : undefined;
  return (
    <>
      <div>
        <fieldset className="mcp-radio">
          <legend>{label}</legend>

          <Radio.Group
            disabled={disabled}
            value={draft.kind}
            onValueChange={(kind) => onChange({ ...draft, kind: kind as AuthDraft["kind"] })}
          >
            <Radio.Item
              className={choiceClass}
              value="oauth"
              label={variant === "settings" ? m.mcp_settings_auth_browser() : m.mcp_auth_oauth()}
            />
            <Radio.Item className={choiceClass} value="bearer" label={m.mcp_auth_token()} />
            <Radio.Item className={choiceClass} value="none" label={m.mcp_auth_none()} />
          </Radio.Group>
        </fieldset>
      </div>
      {!hideKey && draft.kind === "bearer" ? (
        <McpKeyField draft={draft} onChange={onChange} disabled={disabled} />
      ) : null}
    </>
  );
}

function McpKeyField({
  draft,
  onChange,
  disabled,
  hideLabel = false,
  feedbackId,
}: {
  draft: AuthDraft;
  onChange: (draft: AuthDraft) => void;
  disabled: boolean;
  hideLabel?: boolean;
  feedbackId?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field htmlFor="mcp-bearer-key" label={m.mcp_authorize_bearer_label()} hideLabel={hideLabel}>
      <div className="relative">
        <KumoInputControl
          className="w-full pr-12"
          aria-label={m.mcp_authorize_bearer_label()}
          id="mcp-bearer-key"
          type={visible ? "text" : "password"}
          autoComplete="off"
          disabled={disabled}
          aria-describedby={feedbackId}
          value={draft.token}
          onChange={(event) => onChange({ ...draft, token: event.target.value })}
        />
        <Button
          aria-label={visible ? m.mcp_hide_key() : m.mcp_show_key()}
          aria-pressed={visible}
          disabled={disabled}
          className="absolute right-0.5 top-1/2 -translate-y-1/2"
          shape="square"
          size="compact"
          variant="ghost"
          onClick={() => setVisible(!visible)}
        >
          <Icon name={visible ? "eye-slash" : "eye"} />
        </Button>
      </div>
    </Field>
  );
}
