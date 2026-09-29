import { type MCPAgentServer, type MCPServer, MCPServerUrlSchema } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { McpDefaultsDialog } from "./mcp-defaults-dialog.js";
import { McpDisclosure, McpFooter, McpHeaderMode, McpHeaders } from "./mcp-form.js";
import {
  actionError,
  bindingPatch,
  type ConnectionField,
  settingsDraft,
  validHeaders,
  validTokenSettings,
} from "./mcp-form-model.js";
import { useMcpServerDetail, useUpdateMcpBinding } from "./mcp-queries.js";

export function McpSettingsDialog({
  agentId,
  agentName,
  entry,
  onClose,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
}) {
  const detail = useMcpServerDetail(entry.mcpServerId);
  const update = useUpdateMcpBinding(agentId);
  const [draft, setDraft] = useState(() => settingsDraft(entry));
  const [defaults, setDefaults] = useState<MCPServer>();
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const base = defaults ?? detail.data?.server;
  const patch = bindingPatch(entry, draft);
  const dirty = Object.keys(patch).length > 0;
  const valid =
    MCPServerUrlSchema.safeParse(draft.url).success &&
    validTokenSettings(draft) &&
    (draft.headerMode !== "custom" || validHeaders(draft.headers, draft.authHeader));
  const save = async () => {
    if (inFlight.current || !dirty || !valid) return;
    inFlight.current = true;
    setError(undefined);
    try {
      await update.mutateAsync({ mcpServerId: entry.mcpServerId, ...patch });
      onClose();
    } catch (cause) {
      setError(actionError(cause, m.mcp_edit_failed()));
    } finally {
      inFlight.current = false;
    }
  };
  const restore = (field: ConnectionField) => {
    if (base) setDraft({ ...draft, [field]: base[field], cleared: [...new Set([...draft.cleared, field])] });
  };
  const field = (key: ConnectionField, label: string, hint?: string) => (
    <div>
      <Field htmlFor={`mcp-edit-${key}`} label={label} hint={hint}>
        <KumoInputControl
          id={`mcp-edit-${key}`}
          value={draft[key]}
          onChange={(event) =>
            setDraft({ ...draft, [key]: event.target.value, cleared: draft.cleared.filter((value) => value !== key) })
          }
        />
      </Field>
      {!draft.cleared.includes(key) && (entry.overridden[key] || draft[key] !== entry.effective[key]) ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-kumo-subtle">
          <span>{m.mcp_edit_customized({ agent: agentName })}</span>
          <Button
            aria-label={m.mcp_edit_restore_field({ field: label })}
            disabled={!base || detail.isError}
            variant="ghost"
            size="compact"
            onClick={() => restore(key)}
          >
            {m.mcp_edit_restore()}
          </Button>
        </div>
      ) : null}
      {draft.cleared.includes(key) ? <p className="mt-2 text-xs text-kumo-subtle">{m.mcp_edit_restored()}</p> : null}
    </div>
  );
  // Keep this component mounted while account defaults are edited so its unsaved draft survives.
  if (shared)
    return <McpDefaultsDialog serverId={entry.mcpServerId} onClose={() => setShared(false)} onSaved={setDefaults} />;
  return (
    <Dialog
      busy={update.isPending}
      className="mcp-form-dialog"
      title={m.mcp_edit_title({ server: entry.name })}
      description={m.mcp_edit_agent_help({ agent: agentName })}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={update.isPending} className="mcp-fields border-0 p-0">
          {error ? <Banner variant="error">{error}</Banner> : null}
          {field("url", m.mcp_edit_url_label())}
          <McpDisclosure label={m.mcp_advanced()}>
            <div className="grid gap-4">
              {entry.authorization?.kind === "bearer" ? (
                <>
                  {field("authHeader", m.mcp_edit_auth_header_label())}
                  {field("authScheme", m.mcp_edit_auth_scheme_label(), m.mcp_edit_auth_scheme_help())}
                </>
              ) : null}
              <McpHeaderMode value={draft.headerMode} onChange={(headerMode) => setDraft({ ...draft, headerMode })} />
              {draft.headerMode === "custom" ? (
                <>
                  <McpHeaders rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} />
                  {!validHeaders(draft.headers, draft.authHeader) ? (
                    <p className="text-xs text-kumo-danger">{m.mcp_headers_invalid()}</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </McpDisclosure>
          {detail.isError ? (
            <div>
              <p className="text-xs text-kumo-danger">{actionError(detail.error, m.common_request_failed())}</p>
              <Button size="compact" variant="ghost" onClick={() => void detail.refetch()}>
                {m.mcp_retry()}
              </Button>
            </div>
          ) : null}
        </fieldset>
        <Button
          className="mt-2 -ml-2"
          disabled={update.isPending}
          variant="ghost"
          size="compact"
          onClick={() => setShared(true)}
        >
          {m.mcp_defaults_action()}
          <Icon name="arrow-right" />
        </Button>
        <McpFooter onClose={onClose} busy={update.isPending}>
          <Button type="submit" disabled={update.isPending || !dirty || !valid} loading={update.isPending}>
            {m.mcp_edit_submit()}
          </Button>
        </McpFooter>
      </form>
    </Dialog>
  );
}
