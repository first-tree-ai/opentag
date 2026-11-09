import {
  type McpCatalogEntry,
  type McpCatalogSetup,
  type McpInstallableCatalogEntry,
  matchesMcpCatalogEndpoint,
  mcpCatalogSetupHeaderError,
  resolveMcpCatalogSetup,
} from "@opentag/mcp-presets";
import { useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button, Field, KumoInputControl } from "../../../ui/design-system.js";
import { localizedText } from "./mcp-catalog-model.js";

/** No definition or credential is created while the customer is filling this form. */
export function McpCatalogSetupForm({
  entry,
  busy,
  error,
  onConnect,
  onCancel,
}: {
  entry: McpCatalogEntry;
  busy: boolean;
  error?: string;
  onConnect: (entry: McpInstallableCatalogEntry, key: string) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [attempted, setAttempted] = useState(false);
  const resolved = resolveMcpCatalogSetup(entry, url.trim(), headers);
  const addressInvalid = attempted && !matchesMcpCatalogEndpoint(entry, url.trim());
  const fields = entry.setup?.headers ?? [];
  const headerErrors = fields.map((field) => mcpCatalogSetupHeaderError(field, headers[field.name] ?? ""));
  const unmappedError = attempted && !resolved && !addressInvalid && !headerErrors.some(Boolean);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (resolved && token.trim()) onConnect(resolved, token);
      }}
    >
      <p className="text-sm text-kumo-subtle">{entry.setup && localizedText(entry.setup.help)}</p>
      <a href={entry.setup?.documentationUrl} target="_blank" rel="noreferrer" className="text-sm text-kumo-link">
        {m.mcp_setup_instructions()}
      </a>
      <Field
        htmlFor="mcp-setup-url"
        label={m.mcp_settings_address()}
        hint={m.common_required()}
        hintId="mcp-setup-url-hint"
        error={addressInvalid ? m.mcp_setup_address_invalid() : undefined}
        errorId="mcp-setup-url-error"
      >
        <KumoInputControl
          id="mcp-setup-url"
          value={url}
          placeholder={entry.setup?.endpoint?.placeholder}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-required="true"
          aria-invalid={addressInvalid}
          aria-describedby={addressInvalid ? "mcp-setup-url-error" : "mcp-setup-url-hint"}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      {fields.map((field, index) => (
        <SetupHeaderField
          key={field.name}
          field={field}
          value={headers[field.name] ?? ""}
          error={attempted ? headerErrors[index] : undefined}
          busy={busy}
          onChange={(value) => setHeaders((current) => ({ ...current, [field.name]: value }))}
        />
      ))}
      <Field
        htmlFor="mcp-setup-key"
        label={m.mcp_authorize_bearer_label()}
        hint={m.common_required()}
        hintId="mcp-setup-key-hint"
      >
        <KumoInputControl
          id="mcp-setup-key"
          type="password"
          value={token}
          autoComplete="off"
          aria-required="true"
          aria-describedby="mcp-setup-key-hint"
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      {unmappedError ? (
        <p id="mcp-setup-error" role="alert" className="text-sm text-kumo-danger">
          {m.mcp_setup_invalid()}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-kumo-danger">
          {error}
        </p>
      ) : null}
      <footer className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" disabled={busy || !token.trim()} loading={busy}>
          {m.mcp_connect()}
        </Button>
      </footer>
    </form>
  );
}

function fieldErrorText(error: ReturnType<typeof mcpCatalogSetupHeaderError>): string | undefined {
  switch (error) {
    case "required":
      return m.common_required();
    case "integer":
      return m.mcp_setup_integer_error();
    case "invalid":
      return m.mcp_setup_value_invalid();
    default:
      return undefined;
  }
}

function SetupHeaderField({
  field,
  value,
  error,
  busy,
  onChange,
}: {
  field: NonNullable<McpCatalogSetup["headers"]>[number];
  value: string;
  error: ReturnType<typeof mcpCatalogSetupHeaderError>;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const id = `mcp-setup-${field.name}`;
  const hint = [field.required && m.common_required(), field.format === "integer" && m.mcp_setup_integer_hint()]
    .filter(Boolean)
    .join(" · ");
  return (
    <Field
      htmlFor={id}
      label={localizedText(field.label)}
      hint={hint}
      hintId={`${id}-hint`}
      error={fieldErrorText(error)}
      errorId={`${id}-error`}
    >
      <KumoInputControl
        id={id}
        value={value}
        placeholder={field.placeholder}
        inputMode={field.format === "integer" ? "numeric" : undefined}
        autoComplete="off"
        disabled={busy}
        aria-required={field.required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
