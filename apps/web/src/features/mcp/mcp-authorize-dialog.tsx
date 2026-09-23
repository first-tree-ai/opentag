import { type MCPAgentServer, MCPAuthSchemeSchema, MCPCustomAuthHeaderSchema } from "@opentag/shared/browser";
import { useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog } from "../../ui/design-system.js";
import { McpAuthFields, McpFooter } from "./mcp-form.js";
import { type AuthDraft, actionError, authBindingPatch, authDraft, validHeaders } from "./mcp-form-model.js";
import { useSetMcpAuthorization, useStartMcpOAuth, useUpdateMcpBinding } from "./mcp-queries.js";

export function validAuth(draft: AuthDraft, existing: boolean): boolean {
  if (
    draft.kind === "bearer" &&
    (!draft.token.trim() ||
      !MCPCustomAuthHeaderSchema.safeParse(draft.authHeader).success ||
      !MCPAuthSchemeSchema.safeParse(draft.authScheme).success)
  )
    return false;
  return (existing && draft.headerMode !== "custom") || validHeaders(draft.headers, draft.authHeader);
}
/** Authorization writes stay Agent-scoped, including headers set before OAuth discovery. */
export function useMcpAuthorization(agentId: string) {
  const update = useUpdateMcpBinding(agentId);
  const authorize = useSetMcpAuthorization(agentId);
  const oauth = useStartMcpOAuth(agentId);
  return async (entry: MCPAgentServer, draft: AuthDraft) => {
    const patch = authBindingPatch(draft, entry.effective);
    if (draft.headerMode === "inherit" && entry.overridden.extraHeaders) patch.clearExtraHeaders = true;
    if (Object.keys(patch).length) await update.mutateAsync({ mcpServerId: entry.mcpServerId, ...patch });
    if (draft.kind === "oauth") {
      const result = await oauth.mutateAsync({ mcpServerId: entry.mcpServerId });
      window.location.assign(result.authorizationUrl);
      return;
    }
    await authorize.mutateAsync({
      mcpServerId: entry.mcpServerId,
      kind: draft.kind,
      ...(draft.kind === "bearer" ? { bearerKey: draft.token } : {}),
    });
  };
}
export function McpAuthorizeDialog({
  agentId,
  agentName,
  entry,
  onClose,
  onAuthorized,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
  onAuthorized: () => void;
}) {
  const [draft, setDraft] = useState<AuthDraft>(() => ({
    ...authDraft(entry.effective, entry.authorization?.kind ?? "oauth"),
    headerMode: entry.overridden.extraHeaders ? ("custom" as const) : ("inherit" as const),
  }));
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string>();
  const authorize = useMcpAuthorization(agentId);
  const submit = async () => {
    if (inFlight.current || !validAuth(draft, true)) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await authorize(entry, draft);
      if (draft.kind !== "oauth") onAuthorized();
    } catch (cause) {
      setError(actionError(cause, m.mcp_authorize_failed()));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      className="mcp-form-dialog"
      busy={busy}
      title={m.mcp_authorize_title({ server: entry.name })}
      description={m.mcp_for_agent({ agent: agentName })}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="mcp-fields border-0 p-0">
          {error ? <Banner variant="error">{error}</Banner> : null}
          <McpAuthFields draft={draft} onChange={setDraft} existing />
        </fieldset>
        <McpFooter onClose={onClose} busy={busy}>
          <Button type="submit" disabled={busy || !validAuth(draft, true)} loading={busy}>
            {authorizationLabel(draft.kind, entry)}
          </Button>
        </McpFooter>
      </form>
    </Dialog>
  );
}

function authorizationLabel(kind: AuthDraft["kind"], entry: MCPAgentServer): string {
  const replacing = entry.authorization?.kind === kind && entry.authorization.hasCredential;
  if (kind === "oauth") return replacing ? m.mcp_auth_again() : m.mcp_authorize_submit();
  if (kind === "bearer") return replacing ? m.mcp_auth_update() : m.mcp_auth_save();
  return m.mcp_continue();
}
