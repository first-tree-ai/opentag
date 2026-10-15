import type { MCPAuthKind } from "@opentag/shared/browser";
import type { ReactNode } from "react";
import * as m from "../../paraglide/messages.js";
import { Field, KumoInputControl } from "../../ui/design-system.js";
import { McpDisclosure, McpHeaders } from "./mcp-form.js";
import { type ConnectionField, type SettingsDraft, validHeaders, validTokenSettings } from "./mcp-form-model.js";

export function McpConfigurationFields({
  draft,
  kind,
  onChange,
  address = true,
}: {
  draft: SettingsDraft;
  kind: MCPAuthKind;
  onChange: (draft: SettingsDraft) => void;
  address?: boolean;
}) {
  const field = (key: ConnectionField, label: string): ReactNode => (
    <Field htmlFor={`mcp-config-${key}`} label={label}>
      <KumoInputControl
        id={`mcp-config-${key}`}
        value={draft[key]}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <>
      {address ? field("url", m.mcp_settings_address()) : null}
      <McpDisclosure label={m.mcp_settings_advanced()} bordered={false}>
        <div className="grid gap-4">
          {kind === "bearer" ? (
            <div className="mcp-token-fields">
              {field("authHeader", m.mcp_edit_auth_header_label())}
              {field("authScheme", m.mcp_edit_auth_scheme_label())}
              {!validTokenSettings(draft) ? (
                <p role="alert" className="text-sm text-kumo-danger">
                  {m.mcp_headers_invalid()}
                </p>
              ) : null}
            </div>
          ) : null}
          <fieldset className="min-w-0 m-0 border-0 p-0">
            <legend className="mb-2 text-sm font-medium">{m.mcp_edit_advanced()}</legend>
            <McpHeaders rows={draft.headers} onChange={(headers) => onChange({ ...draft, headers })} />
          </fieldset>
          {!validHeaders(
            draft.headers,
            kind === "oauth" ? "authorization" : kind === "bearer" ? draft.authHeader : "",
          ) ? (
            <p role="alert" className="text-sm text-kumo-danger">
              {m.mcp_headers_invalid()}
            </p>
          ) : null}
        </div>
      </McpDisclosure>
    </>
  );
}
