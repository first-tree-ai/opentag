import { type McpCatalogEntry, type McpInstallableCatalogEntry, resolveMcpCatalogSetup } from "@opentag/mcp-presets";
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
      <Field htmlFor="mcp-setup-url" label={m.mcp_settings_address()}>
        <KumoInputControl
          id="mcp-setup-url"
          value={url}
          placeholder={entry.setup?.endpoint?.placeholder}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-invalid={attempted && !resolved}
          aria-describedby={attempted && !resolved ? "mcp-setup-error" : undefined}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      {(entry.setup?.headers ?? []).map((field) => (
        <Field key={field.name} htmlFor={`mcp-setup-${field.name}`} label={localizedText(field.label)}>
          <KumoInputControl
            id={`mcp-setup-${field.name}`}
            value={headers[field.name] ?? ""}
            placeholder={field.placeholder}
            inputMode={field.format === "integer" ? "numeric" : undefined}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setHeaders((current) => ({ ...current, [field.name]: event.target.value }))}
          />
        </Field>
      ))}
      <Field htmlFor="mcp-setup-key" label={m.mcp_authorize_bearer_label()}>
        <KumoInputControl
          id="mcp-setup-key"
          type="password"
          value={token}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      {attempted && !resolved ? (
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
