import {
  type MCPServer,
  type MCPServerDetail,
  MCPServerUrlSchema,
  type UpdateMCPServerRequest,
} from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Field, KumoInputControl, Loader } from "../../ui/design-system.js";
import { agentMcpLink } from "../agents/agent-routes.js";
import { McpDisclosure, McpFooter, McpHeaders, McpTokenSettings } from "./mcp-form.js";
import {
  actionError,
  type HeaderRow,
  headerRows,
  headersFromRows,
  headersKey,
  validHeaders,
  validTokenSettings,
} from "./mcp-form-model.js";
import { useMcpServerDetail, useRemoveMcpServer, useUpdateMcpServer } from "./mcp-queries.js";

type DefaultsDraft = { url: string; description: string; authHeader: string; authScheme: string; headers: HeaderRow[] };
const fromServer = (server: MCPServer): DefaultsDraft => ({
  ...server,
  description: server.description ?? "",
  headers: headerRows(server.extraHeaders),
});
function defaultsPatch(base: MCPServer, draft: DefaultsDraft): UpdateMCPServerRequest {
  const description = draft.description.trim() || null;
  return {
    expectedRevision: base.revision,
    ...(draft.url !== base.url ? { url: draft.url } : {}),
    ...(description !== base.description ? { description } : {}),
    ...(draft.authHeader !== base.authHeader ? { authHeader: draft.authHeader } : {}),
    ...(draft.authScheme !== base.authScheme ? { authScheme: draft.authScheme } : {}),
    ...(headersKey(headersFromRows(draft.headers)) !== headersKey(base.extraHeaders)
      ? { extraHeaders: headersFromRows(draft.headers) }
      : {}),
  };
}
export function McpDefaultsDialog({
  serverId,
  onClose,
  onSaved,
  onDeleted,
}: {
  serverId: string;
  onClose: () => void;
  onSaved?: (server: MCPServer) => void;
  onDeleted?: () => void;
}) {
  const detail = useMcpServerDetail(serverId);
  if (!detail.data)
    return (
      <Dialog className="mcp-form-dialog" title={m.mcp_defaults_action()} onClose={onClose}>
        {detail.isError ? (
          <div className="grid gap-3">
            <Banner variant="error">{actionError(detail.error, m.common_request_failed())}</Banner>
            <Button onClick={() => void detail.refetch()}>{m.mcp_retry()}</Button>
          </div>
        ) : (
          <Loader />
        )}
      </Dialog>
    );
  return (
    <DefaultsEditor
      detail={detail.data}
      readFailed={detail.isError}
      reload={async () => {
        const result = await detail.refetch();
        if (result.error) throw result.error;
        if (!result.data) throw new Error("Missing MCP defaults");
        return result.data;
      }}
      onClose={onClose}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  );
}
function DefaultsEditor({
  detail,
  readFailed,
  reload,
  onClose,
  onSaved,
  onDeleted,
}: {
  detail: MCPServerDetail;
  readFailed: boolean;
  reload: () => Promise<MCPServerDetail>;
  onClose: () => void;
  onSaved?: (server: MCPServer) => void;
  onDeleted?: () => void;
}) {
  const [base, setBase] = useState(detail.server);
  const [draft, setDraft] = useState(() => fromServer(detail.server));
  const update = useUpdateMcpServer();
  const remove = useRemoveMcpServer();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const patch = defaultsPatch(base, draft);
  const dirty = Object.keys(patch).length > 1;
  const valid =
    MCPServerUrlSchema.safeParse(draft.url).success &&
    validTokenSettings(draft) &&
    validHeaders(draft.headers, draft.authHeader);
  const save = async () => {
    if (inFlight.current || !dirty || !valid || conflict || readFailed) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await update.mutateAsync({ mcpServerId: base.id, ...patch });
      onSaved?.(saved);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "MCP_SERVER_REVISION_CONFLICT") setConflict(true);
      setError(actionError(cause, m.mcp_edit_failed()));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const reloadLatest = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const latest = (await reload()).server;
      // Keep edits, while untouched fields follow the latest defaults rather than overwriting them.
      const next = fromServer(latest);
      setDraft({
        url: patch.url ?? next.url,
        description: "description" in patch ? draft.description : next.description,
        authHeader: patch.authHeader ?? next.authHeader,
        authScheme: patch.authScheme ?? next.authScheme,
        headers: patch.extraHeaders ? draft.headers : next.headers,
      });
      setBase(latest);
      setConflict(false);
      setReloaded(true);
    } catch (cause) {
      setError(actionError(cause, m.common_request_failed()));
    } finally {
      setBusy(false);
    }
  };
  const deleteServer = async () => {
    if (inFlight.current || readFailed || detail.server.boundAgentCount > 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await remove.mutateAsync(base.id);
      onDeleted?.();
      onClose();
    } catch (cause) {
      setError(actionError(cause, m.mcp_remove_failed()));
      try {
        await reload();
      } catch (readError) {
        setError(`${actionError(cause, m.mcp_remove_failed())} ${actionError(readError, m.common_request_failed())}`);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (deleting)
    return (
      <DeleteConfirmation
        busy={busy}
        error={error}
        readFailed={readFailed}
        detail={detail}
        name={base.name}
        onClose={() => {
          setDeleting(false);
          setError(undefined);
        }}
        onDelete={() => void deleteServer()}
      />
    );
  return (
    <Dialog
      busy={busy}
      className="mcp-form-dialog"
      title={m.mcp_defaults_title({ server: base.name })}
      description={m.mcp_defaults_scope()}
      onClose={onClose}
    >
      <UsedBy detail={detail} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="mcp-fields border-0 p-0">
          {error || readFailed ? (
            <Banner variant="error">
              {conflict ? m.mcp_defaults_changed() : (error ?? m.common_request_failed())}
            </Banner>
          ) : null}
          {conflict || readFailed ? (
            <Button variant="secondary" onClick={() => void reloadLatest()}>
              {m.mcp_defaults_reload()}
            </Button>
          ) : null}
          {reloaded ? (
            <p className="text-xs text-kumo-subtle" role="status">
              {m.mcp_defaults_reloaded()}
            </p>
          ) : null}
          <Field htmlFor="mcp-default-url" label={m.mcp_url_label()}>
            <KumoInputControl
              id="mcp-default-url"
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </Field>
          {patch.url ? <p className="text-xs text-kumo-subtle">{m.mcp_defaults_url_change()}</p> : null}
          <Field htmlFor="mcp-default-description" label={m.mcp_description_label()} hint={m.mcp_optional()}>
            <KumoInputControl
              id="mcp-default-description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <McpDisclosure label={m.mcp_advanced()}>
            <div className="grid gap-4">
              <p className="text-xs text-kumo-subtle">{m.mcp_defaults_token_help()}</p>
              <McpTokenSettings
                header={draft.authHeader}
                prefix={draft.authScheme}
                onHeader={(authHeader) => setDraft({ ...draft, authHeader })}
                onPrefix={(authScheme) => setDraft({ ...draft, authScheme })}
              />
              <span className="text-sm font-medium">{m.mcp_edit_advanced()}</span>
              <McpHeaders rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} />
              {!validHeaders(draft.headers, draft.authHeader) ? (
                <p className="text-xs text-kumo-danger">{m.mcp_headers_invalid()}</p>
              ) : null}
            </div>
          </McpDisclosure>
        </fieldset>
        <McpFooter onClose={onClose} busy={busy}>
          <Button type="submit" disabled={busy || !dirty || !valid || conflict || readFailed} loading={busy}>
            {m.mcp_defaults_save()}
          </Button>
        </McpFooter>
      </form>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-kumo-line pt-4">
        <Button
          className="-ml-2 text-kumo-danger"
          disabled={busy || readFailed || detail.server.boundAgentCount > 0}
          variant="ghost"
          size="compact"
          onClick={() => setDeleting(true)}
        >
          {m.mcp_delete_action()}
        </Button>
        {detail.server.boundAgentCount > 0 ? (
          <p className="text-xs text-kumo-subtle">{m.mcp_delete_blocked()}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function UsedBy({ detail }: { detail: MCPServerDetail }) {
  return (
    <p className="mb-6 text-sm text-kumo-subtle">
      {detail.agents.length ? (
        <>
          {m.mcp_defaults_used_by()}{" "}
          {detail.agents.map((agent, index) => (
            <span key={agent.agentId}>
              {index ? ", " : ""}
              <Link {...agentMcpLink(agent.agentId)} className="underline underline-offset-4">
                {agent.agentDisplayName}
              </Link>
            </span>
          ))}
        </>
      ) : (
        m.mcp_defaults_unused()
      )}
    </p>
  );
}

function DeleteConfirmation({
  busy,
  error,
  readFailed,
  detail,
  name,
  onClose,
  onDelete,
}: {
  busy: boolean;
  error?: string;
  readFailed: boolean;
  detail: MCPServerDetail;
  name: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <Dialog
      className="mcp-confirm-dialog"
      busy={busy}
      role="alertdialog"
      title={m.mcp_delete_title({ server: name })}
      description={m.mcp_delete_description()}
      onClose={onClose}
    >
      {error ? <Banner variant="error">{error}</Banner> : null}
      {detail.server.boundAgentCount > 0 ? <p className="mt-3 text-sm">{m.mcp_delete_blocked()}</p> : null}
      <McpFooter onClose={onClose} busy={busy}>
        <Button
          variant="danger"
          disabled={busy || readFailed || detail.server.boundAgentCount > 0}
          loading={busy}
          onClick={onDelete}
        >
          {m.mcp_delete_action()}
        </Button>
      </McpFooter>
    </Dialog>
  );
}
