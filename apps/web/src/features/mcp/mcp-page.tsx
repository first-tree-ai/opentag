import type { MCPAgentServer, MCPAuthKind, MCPAvailableServer, MCPToolSnapshot } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import {
  Banner,
  Button,
  Checkbox,
  Collapsible,
  Dialog,
  Field,
  Icon,
  KumoInputControl,
  KumoSelectControl,
  Radio,
  Text,
} from "../../ui/design-system.js";
import { readMcpOAuthOutcome } from "./mcp-oauth-outcome.js";
import { sharedDefinitionImpact } from "./mcp-page-model.js";
import {
  useAgentMcpServers,
  useAttachMcpServer,
  useAvailableMcpServers,
  useCreateMcpServer,
  useDetachMcpServer,
  useMcpServerDetail,
  useProbeMcpServer,
  useRemoveMcpServer,
  useRevokeMcpAuthorization,
  useSetMcpAuthorization,
  useStartMcpOAuth,
  useUpdateMcpBinding,
  useUpdateMcpServer,
} from "./mcp-queries.js";
import { McpServerCard } from "./mcp-server-card.js";

/**
 * One Agent's MCP Servers, backed by the real management API.
 *
 * The page is the Agent's view, so authorization is configured here with no scope selector: every
 * credential belongs to this Agent. Editing is the one place scope matters, and its dialog opens on
 * "this Agent only" — the shared definition is a deliberate second choice that names the Agents it
 * will affect.
 *
 * What the page does **not** claim: an Agent calling these tools. Runtime delivery is not part of
 * this release, so the discovered tools are a credential-scoped snapshot the user can inspect, not a
 * promise that a turn will invoke them.
 */

type Panel =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "authorize"; entry: MCPAgentServer }
  | { kind: "edit"; entry: MCPAgentServer }
  | { kind: "remove"; entry: MCPAgentServer }
  | { kind: "revoke"; entry: MCPAgentServer }
  | { kind: "tools"; entry: MCPAgentServer };

export function McpPage({ agentId }: { agentId: string }) {
  /*
   * Read the Agent directly rather than through the Account session: the page needs one display name,
   * and this keeps it mountable in a test with no session provider around it — the same shape the
   * GitHub repository page uses.
   */
  const identity = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => browserApi.agent(agentId),
  });
  const agentDisplayName = identity.data?.displayName ?? agentId;
  const [outcome] = useState(() => readMcpOAuthOutcome());
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [actionError, setActionError] = useState<string | undefined>();
  const mounted = useAgentMcpServers(agentId);

  const close = useCallback(() => {
    setActionError(undefined);
    setPanel({ kind: "none" });
  }, []);

  const servers = mounted.data?.servers ?? [];

  return (
    <section className="grid gap-6" aria-labelledby="mcp-page-title" data-ui="mcp-page">
      <PageHeader description={m.mcp_intro()} title={m.mcp_heading()} titleId="mcp-page-title">
        <Button onClick={() => setPanel({ kind: "create" })} variant="secondary">
          <Icon name="plus" />
          {m.mcp_create_action()}
        </Button>
      </PageHeader>

      {outcome ? (
        <Banner variant={outcome.outcome.kind === "success" ? "default" : "error"}>
          {outcome.outcome.kind === "success"
            ? m.mcp_authorization_status_active()
            : describeOAuthError(outcome.outcome.code)}
        </Banner>
      ) : null}
      {actionError ? <Banner variant="error">{actionError}</Banner> : null}
      {mounted.isError ? <Banner variant="error">{describeLoadError(mounted.error)}</Banner> : null}

      <McpServerList
        agentId={agentId}
        isPending={mounted.isPending}
        onAction={setPanel}
        onError={setActionError}
        servers={servers}
      />

      <McpPanel agentDisplayName={agentDisplayName} agentId={agentId} onClose={close} panel={panel} />
    </section>
  );
}

/** The mounted Servers, or the reason there are none to show. */
function McpServerList({
  agentId,
  isPending,
  onAction,
  onError,
  servers,
}: {
  agentId: string;
  isPending: boolean;
  onAction: (panel: Panel) => void;
  onError: (message: string) => void;
  servers: MCPAgentServer[];
}) {
  if (isPending) return <Text variant="body">{m.common_loading()}</Text>;
  if (servers.length === 0) return <Text variant="secondary">{m.mcp_empty()}</Text>;
  return (
    <ul className="grid gap-3" data-ui="mcp-server-list">
      {servers.map((entry) => (
        <McpRow agentId={agentId} entry={entry} key={entry.mcpServerId} onAction={onAction} onError={onError} />
      ))}
    </ul>
  );
}

/** Whichever dialog is open, as one dispatch rather than a column of ternaries in the page body. */
function McpPanel({
  agentDisplayName,
  agentId,
  onClose,
  panel,
}: {
  agentDisplayName: string;
  agentId: string;
  onClose: () => void;
  panel: Panel;
}) {
  switch (panel.kind) {
    case "create":
      return <CreateServerDialog agentId={agentId} onClose={onClose} />;
    case "authorize":
      return (
        <AuthorizeDialog agentDisplayName={agentDisplayName} agentId={agentId} entry={panel.entry} onClose={onClose} />
      );
    case "edit":
      return <EditDialog agentId={agentId} entry={panel.entry} onClose={onClose} />;
    case "remove":
      return <RemoveDialog agentId={agentId} entry={panel.entry} onClose={onClose} />;
    case "revoke":
      return <RevokeDialog agentId={agentId} entry={panel.entry} onClose={onClose} />;
    case "tools":
      return <ToolsDialog entry={panel.entry} onClose={onClose} />;
    default:
      return null;
  }
}

function McpRow({
  agentId,
  entry,
  onAction,
  onError,
}: {
  agentId: string;
  entry: MCPAgentServer;
  onAction: (panel: Panel) => void;
  onError: (message: string) => void;
}) {
  const updateBinding = useUpdateMcpBinding(agentId);
  const probe = useProbeMcpServer(agentId);

  const toggle = async () => {
    onError("");
    try {
      await updateBinding.mutateAsync({ mcpServerId: entry.mcpServerId, enabled: !entry.enabled });
    } catch (error) {
      onError(describeActionError(error, m.mcp_attach_failed()));
    }
  };

  const reprobe = async () => {
    onError("");
    try {
      await probe.mutateAsync(entry.mcpServerId);
    } catch (error) {
      onError(describeActionError(error, m.mcp_probe_failed()));
    }
  };

  return (
    <McpServerCard
      entry={entry}
      onAction={(kind) => onAction({ kind, entry })}
      onProbe={() => void reprobe()}
      onToggle={() => void toggle()}
      probing={probe.isPending}
      toggling={updateBinding.isPending}
    />
  );
}

type CreateMode = "new" | "existing";

function CreateServerDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const create = useCreateMcpServer(agentId);
  /*
   * Creating a definition is Account-level and mounting it is per Agent, so these are two calls. Both
   * belong here: the button says "new MCP Server" and the Agent page it is pressed from lists mounted
   * Servers, so a definition that is left unmounted is invisible on the page that created it — the
   * user sees a success and then nothing, which reads as a failure.
   */
  const attach = useAttachMcpServer(agentId);
  /*
   * One entry point, two ways to add a Server.
   *
   * The mode chooser is here rather than a second button because `mcp_servers` is unique on
   * `(account, lower(name))`: a user who wants an existing Server on a second Agent cannot create it
   * again, and giving it another name would create a second definition — a separate identity with its
   * own probes and its own edit surface. Mounting the existing one is the only correct move there, so
   * it has to stay reachable; keeping it inside this dialog keeps create-and-mount the default path.
   */
  const [mode, setMode] = useState<CreateMode>("new");
  const available = useAvailableMcpServers(agentId, mode === "existing");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [defaultAuthKind, setDefaultAuthKind] = useState<MCPAuthKind>("oauth");
  const [authHeader, setAuthHeader] = useState("");
  const [authScheme, setAuthScheme] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    setError(undefined);
    try {
      const created = await create.mutateAsync({
        name,
        url,
        defaultAuthKind,
        ...(authHeader ? { authHeader } : {}),
        ...(authScheme ? { authScheme } : {}),
      });
      await attach.mutateAsync(created.id);
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_create_failed()));
    }
  };

  /** Mount a definition that already exists in this Account, which needs no name or URL. */
  const addExisting = async (server: MCPAvailableServer) => {
    setError(undefined);
    try {
      await attach.mutateAsync(server.id);
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_attach_failed()));
    }
  };

  const busy = create.isPending || attach.isPending;

  return (
    <Dialog busy={busy} description={m.mcp_create_description()} onClose={onClose} title={m.mcp_create_title()}>
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        <Field htmlFor="mcp-add-mode" label={m.mcp_add_mode_label()}>
          <KumoSelectControl
            id="mcp-add-mode"
            onValueChange={(value) => {
              setMode(value as CreateMode);
              setError(undefined);
            }}
            value={mode}
          >
            <option value="new">{m.mcp_create_action()}</option>
            <option value="existing">{m.mcp_add_existing()}</option>
          </KumoSelectControl>
        </Field>
        {mode === "existing" ? (
          <ExistingServerChooser
            isPending={available.isPending}
            onAdd={addExisting}
            pending={attach.isPending}
            servers={available.data?.servers ?? []}
          />
        ) : (
          <>
            <Field hint={m.mcp_name_help()} htmlFor="mcp-name" label={m.mcp_name_label()}>
              <KumoInputControl onChange={(event) => setName(event.target.value)} value={name} />
            </Field>
            <Field htmlFor="mcp-url" label={m.mcp_url_label()}>
              <KumoInputControl onChange={(event) => setUrl(event.target.value)} value={url} />
            </Field>
            <Field hint={m.mcp_default_auth_help()} htmlFor="mcp-default-auth" label={m.mcp_default_auth_label()}>
              <KumoSelectControl
                id="mcp-default-auth"
                onValueChange={(value) => setDefaultAuthKind(value as MCPAuthKind)}
                value={defaultAuthKind}
              >
                <option value="oauth">{m.mcp_authorization_oauth()}</option>
                <option value="bearer">{m.mcp_authorization_bearer()}</option>
                <option value="none">{m.mcp_authorization_anonymous()}</option>
              </KumoSelectControl>
            </Field>
            <Checkbox
              checked={advanced}
              label={m.mcp_create_advanced()}
              onCheckedChange={(next) => setAdvanced(next === true)}
            />
            {advanced ? (
              <>
                <Field htmlFor="mcp-auth-header" label={m.mcp_edit_auth_header_label()}>
                  <KumoInputControl onChange={(event) => setAuthHeader(event.target.value)} value={authHeader} />
                </Field>
                <Field
                  hint={m.mcp_edit_auth_scheme_help()}
                  htmlFor="mcp-auth-scheme"
                  label={m.mcp_edit_auth_scheme_label()}
                >
                  <KumoInputControl onChange={(event) => setAuthScheme(event.target.value)} value={authScheme} />
                </Field>
              </>
            ) : null}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            {m.common_cancel()}
          </Button>
          {/* Mounting an existing Server has its own per-row button, so the primary action is create-only. */}
          {mode === "new" ? (
            <Button disabled={busy || !name || !url} onClick={submit} variant="primary">
              {m.mcp_create_submit()}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** The Account's unmounted definitions, each with the button that mounts it on this Agent. */
function ExistingServerChooser({
  isPending,
  onAdd,
  pending,
  servers,
}: {
  isPending: boolean;
  onAdd: (server: MCPAvailableServer) => void;
  pending: boolean;
  servers: MCPAvailableServer[];
}) {
  if (isPending) return <Text variant="body">{m.common_loading()}</Text>;
  if (servers.length === 0) return <Text variant="body">{m.mcp_add_existing_empty()}</Text>;
  return (
    <ul className="grid gap-2" data-ui="mcp-available-list">
      {servers.map((server) => (
        <li className="flex items-center justify-between gap-2 rounded border border-kumo-line p-3" key={server.id}>
          <div className="grid gap-0.5">
            <Text variant="body">{server.name}</Text>
            <Text variant="secondary">{server.description ?? server.name}</Text>
          </div>
          <Button disabled={pending} onClick={() => onAdd(server)} size="compact" variant="secondary">
            {m.mcp_attach_action()}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function AuthorizeDialog({
  agentDisplayName,
  agentId,
  entry,
  onClose,
}: {
  agentDisplayName: string;
  agentId: string;
  entry: MCPAgentServer;
  onClose: () => void;
}) {
  const setAuthorization = useSetMcpAuthorization(agentId);
  const startOAuth = useStartMcpOAuth(agentId);
  const [kind, setKind] = useState<MCPAuthKind>(
    entry.authorization?.kind === "none" ? "none" : (entry.authorization?.kind ?? "oauth"),
  );
  const [bearerKey, setBearerKey] = useState("");
  const [error, setError] = useState<string | undefined>();
  const busy = setAuthorization.isPending || startOAuth.isPending;

  const submit = async () => {
    setError(undefined);
    try {
      if (kind === "oauth") {
        const started = await startOAuth.mutateAsync({ mcpServerId: entry.mcpServerId });
        // A full navigation, not a fetch: the authorization server must see this in the top-level
        // browsing context so the session it establishes survives the return trip.
        window.location.assign(started.authorizationUrl);
        return;
      }
      await setAuthorization.mutateAsync({
        mcpServerId: entry.mcpServerId,
        kind: kind === "none" ? "none" : "bearer",
        ...(kind === "bearer" ? { bearerKey } : {}),
      });
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_authorize_failed()));
    }
  };

  return (
    <Dialog
      busy={busy}
      description={m.mcp_authorize_dialog_description()}
      onClose={onClose}
      title={m.mcp_authorize_title({ server: entry.name, agent: agentDisplayName })}
    >
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        <Field htmlFor="mcp-authorize-kind" label={m.mcp_authorize_kind_label()}>
          <KumoSelectControl
            id="mcp-authorize-kind"
            onValueChange={(value) => setKind(value as MCPAuthKind)}
            value={kind}
          >
            <option value="oauth">{m.mcp_authorization_oauth()}</option>
            <option value="bearer">{m.mcp_authorization_bearer()}</option>
            <option value="none">{m.mcp_authorization_anonymous()}</option>
          </KumoSelectControl>
        </Field>
        {kind === "oauth" ? <Text variant="secondary">{m.mcp_authorize_oauth_description()}</Text> : null}
        {kind === "none" ? <Text variant="secondary">{m.mcp_authorize_none_description()}</Text> : null}
        {kind === "bearer" ? (
          <Field
            hint={m.mcp_authorize_bearer_description()}
            htmlFor="mcp-bearer-key"
            label={m.mcp_authorize_bearer_label()}
          >
            {/* A one-way input: the value is never read back, because no response carries it. */}
            <KumoInputControl
              autoComplete="off"
              onChange={(event) => setBearerKey(event.target.value)}
              type="password"
              value={bearerKey}
            />
          </Field>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            {m.common_cancel()}
          </Button>
          <Button disabled={busy || (kind === "bearer" && bearerKey.length === 0)} onClick={submit} variant="primary">
            {m.mcp_authorize_submit()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

type EditScope = "agent" | "shared";

function EditDialog({ agentId, entry, onClose }: { agentId: string; entry: MCPAgentServer; onClose: () => void }) {
  const [scope, setScope] = useState<EditScope>("agent");
  const detail = useMcpServerDetail(entry.mcpServerId);
  const updateBinding = useUpdateMcpBinding(agentId);
  const updateServer = useUpdateMcpServer(agentId);
  const [url, setUrl] = useState(entry.effective.url);
  const [authHeader, setAuthHeader] = useState(entry.effective.authHeader);
  const [authScheme, setAuthScheme] = useState(entry.effective.authScheme);
  const [extraHeaders, setExtraHeaders] = useState<HeaderRow[]>(headerRows(entry.effective.extraHeaders));
  /*
   * Seeded from the operator's stored override, never from the probed value: an empty field means
   * "show what the probe found", and prefilling it would silently freeze the probe's words into an
   * override the first time anyone saved for an unrelated reason.
   */
  const [description, setDescription] = useState(entry.description ?? "");
  const [error, setError] = useState<string | undefined>();
  const busy = updateBinding.isPending || updateServer.isPending;

  const impact = useMemo(() => (detail.data ? sharedDefinitionImpact(detail.data) : undefined), [detail.data]);

  /*
   * Sorted by name, because the rows are a set: reordering them changes nothing about what the Server
   * receives, and comparing serialized order marked the field changed and pinned an override for it.
   */
  const headersChanged =
    sortedHeadersKey(headersFromRows(extraHeaders)) !== sortedHeadersKey(entry.effective.extraHeaders);

  /*
   * Only the fields the user actually changed are sent.
   *
   * Submitting every field is what made an unrelated edit pin the rest: opening this dialog, changing
   * only the URL, and saving froze `authHeader`, `authScheme`, and the extra headers as this Agent's
   * overrides of the effective values — so later shared edits silently stopped reaching it. Comparing
   * against what the form was seeded with is what distinguishes "the user typed this" from "this is
   * what was on screen".
   */
  const bindingPatch = () => ({
    ...(url !== entry.effective.url ? { url } : {}),
    ...(authHeader !== entry.effective.authHeader ? { authHeader } : {}),
    ...(authScheme !== entry.effective.authScheme ? { authScheme } : {}),
    ...(headersChanged ? { extraHeaders: headersFromRows(extraHeaders) } : {}),
  });

  /**
   * Restore one inherited value for this Agent, immediately.
   *
   * A separate action from Save, and it closes the dialog when it succeeds: the clear is a complete
   * intent on its own, and leaving the form open invited a following Save to re-pin what was just
   * cleared.
   */
  const restoreShared = async (clear: {
    clearUrl?: true;
    clearAuthHeader?: true;
    clearAuthScheme?: true;
    clearExtraHeaders?: true;
    emptyExtraHeaders?: true;
  }) => {
    setError(undefined);
    try {
      await updateBinding.mutateAsync({ mcpServerId: entry.mcpServerId, ...clear });
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_edit_failed()));
    }
  };

  const submit = async () => {
    setError(undefined);
    try {
      if (scope === "shared") {
        /*
         * The shared definition is edited with the definition's own values, not this Agent's effective
         * ones: an Agent-level override shown in the form would otherwise be copied onto every other
         * Agent as soon as anyone edited the shared scope.
         */
        await updateServer.mutateAsync({
          mcpServerId: entry.mcpServerId,
          url,
          authHeader,
          authScheme,
          extraHeaders: headersFromRows(extraHeaders),
          description: description.trim() === "" ? null : description.trim(),
          expectedRevision: detail.data?.server.revision ?? 1,
        });
      } else {
        await updateBinding.mutateAsync({
          mcpServerId: entry.mcpServerId,
          ...bindingPatch(),
        });
      }
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_edit_failed()));
    }
  };

  return (
    <Dialog busy={busy} onClose={onClose} title={m.mcp_edit_title({ server: entry.name })}>
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        {scope === "shared" ? (
          <Field hint={m.mcp_description_edit_help()} htmlFor="mcp-edit-description" label={m.mcp_description_label()}>
            <KumoInputControl onChange={(event) => setDescription(event.target.value)} value={description} />
          </Field>
        ) : null}
        <Field htmlFor="mcp-edit-scope" label={m.mcp_edit_scope_label()}>
          <KumoSelectControl id="mcp-edit-scope" onValueChange={(value) => setScope(value as EditScope)} value={scope}>
            <option value="agent">{m.mcp_edit_scope_agent()}</option>
            <option value="shared">{m.mcp_edit_scope_shared()}</option>
          </KumoSelectControl>
        </Field>
        {scope === "agent" ? (
          <Text variant="secondary">{m.mcp_edit_scope_agent_description()}</Text>
        ) : (
          <Banner variant="alert">{describeImpact(impact?.count ?? 0, impact?.names ?? [])}</Banner>
        )}

        <Field htmlFor="mcp-edit-url" label={m.mcp_edit_url_label()}>
          <KumoInputControl onChange={(event) => setUrl(event.target.value)} value={url} />
        </Field>
        {scope === "agent" && entry.overridden.url ? (
          <Button onClick={() => void restoreShared({ clearUrl: true })} size="compact" variant="ghost">
            {m.mcp_edit_clear_url()}
          </Button>
        ) : null}
        <Field htmlFor="mcp-auth-header" label={m.mcp_edit_auth_header_label()}>
          <KumoInputControl onChange={(event) => setAuthHeader(event.target.value)} value={authHeader} />
        </Field>
        {scope === "agent" && entry.overridden.authHeader ? (
          <Button onClick={() => void restoreShared({ clearAuthHeader: true })} size="compact" variant="ghost">
            {m.mcp_edit_clear_auth_header()}
          </Button>
        ) : null}
        <Field hint={m.mcp_edit_auth_scheme_help()} htmlFor="mcp-auth-scheme" label={m.mcp_edit_auth_scheme_label()}>
          <KumoInputControl onChange={(event) => setAuthScheme(event.target.value)} value={authScheme} />
        </Field>
        {scope === "agent" && entry.overridden.authScheme ? (
          <Button onClick={() => void restoreShared({ clearAuthScheme: true })} size="compact" variant="ghost">
            {m.mcp_edit_clear_auth_scheme()}
          </Button>
        ) : null}

        <div className="grid gap-2">
          <Text variant="body">{m.mcp_edit_advanced()}</Text>
          <Text variant="secondary">
            {m.mcp_edit_effective_extra_headers({ value: describeHeaders(entry.effective.extraHeaders) })}
          </Text>
          {extraHeaders.map((row, index) => (
            <div className="flex items-center gap-2" key={row.id}>
              <KumoInputControl
                aria-label={m.mcp_edit_header_name()}
                onChange={(event) =>
                  setExtraHeaders(replaceRow(extraHeaders, index, { ...row, name: event.target.value }))
                }
                value={row.name}
              />
              <KumoInputControl
                aria-label={m.mcp_edit_header_value()}
                onChange={(event) =>
                  setExtraHeaders(replaceRow(extraHeaders, index, { ...row, value: event.target.value }))
                }
                value={row.value}
              />
              <Button
                aria-label={m.mcp_edit_header_remove()}
                onClick={() => setExtraHeaders(extraHeaders.filter((candidate) => candidate.id !== row.id))}
                shape="square"
                size="compact"
                variant="ghost"
              >
                <Icon name="close" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => setExtraHeaders([...extraHeaders, blankHeaderRow()])}
              size="compact"
              variant="secondary"
            >
              {m.mcp_edit_header_add()}
            </Button>
            {scope === "agent" ? (
              <>
                {/*
                 * Two different actions, deliberately both present: clearing restores inheritance,
                 * while sending none keeps the override and empties it. A user who wants the shared
                 * x-workspace-id gone for this Agent only needs the second.
                 */}
                <Button onClick={() => void restoreShared({ clearExtraHeaders: true })} size="compact" variant="ghost">
                  {m.mcp_edit_clear_extra_headers()}
                </Button>
                <Button
                  /*
                   * The same path as the other restores: awaited, reported on failure, and closed on
                   * success. As a bare `void` it reported nothing, and because it no longer cleared the
                   * local rows, `headersChanged` stayed true — so a following Save sent the headers
                   * straight back as an override, undoing the button.
                   */
                  onClick={() => void restoreShared({ emptyExtraHeaders: true })}
                  size="compact"
                  variant="ghost"
                >
                  {m.mcp_edit_empty_extra_headers()}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            {m.common_cancel()}
          </Button>
          <Button disabled={busy} onClick={submit} variant="primary">
            {m.mcp_edit_submit()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RemoveDialog({ agentId, entry, onClose }: { agentId: string; entry: MCPAgentServer; onClose: () => void }) {
  const detail = useMcpServerDetail(entry.mcpServerId);
  const detach = useDetachMcpServer(agentId);
  const remove = useRemoveMcpServer(agentId);
  const [mode, setMode] = useState<"detach" | "delete">("detach");
  const [error, setError] = useState<string | undefined>();
  const others = detail.data ? detail.data.agents.filter((agent) => agent.agentId !== agentId) : [];
  const busy = detach.isPending || remove.isPending;

  const submit = async () => {
    setError(undefined);
    try {
      await detach.mutateAsync(entry.mcpServerId);
      if (mode === "delete") await remove.mutateAsync(entry.mcpServerId);
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_remove_failed()));
    }
  };

  return (
    <Dialog busy={busy} onClose={onClose} title={m.mcp_detach_title({ server: entry.name })}>
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        {/* The group carries no legend of its own: the dialog title above already names the choice. */}
        <Radio.Group onValueChange={(value) => setMode(value as "detach" | "delete")} value={mode}>
          <Radio.Item
            appearance="card"
            description={m.mcp_detach_only_description()}
            label={m.mcp_detach_only_label()}
            value="detach"
          />
          <Radio.Item
            /*
             * Disabled while another Agent uses it. The Server refuses the delete in that case
             * anyway, so offering it would only produce an error the user cannot act on.
             */
            appearance="card"
            description={
              others.length > 0
                ? describeImpact(
                    others.length,
                    others.map((agent) => agent.agentDisplayName),
                  )
                : m.mcp_detach_and_delete_description()
            }
            disabled={others.length > 0}
            label={m.mcp_detach_and_delete_label()}
            value="delete"
          />
        </Radio.Group>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            {m.common_cancel()}
          </Button>
          <Button disabled={busy} onClick={submit} variant="primary">
            {m.mcp_detach_action()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RevokeDialog({ agentId, entry, onClose }: { agentId: string; entry: MCPAgentServer; onClose: () => void }) {
  const revoke = useRevokeMcpAuthorization(agentId);
  const [error, setError] = useState<string | undefined>();
  const submit = async () => {
    setError(undefined);
    try {
      await revoke.mutateAsync(entry.mcpServerId);
      onClose();
    } catch (cause) {
      setError(describeActionError(cause, m.mcp_revoke_failed()));
    }
  };
  return (
    <Dialog
      busy={revoke.isPending}
      description={m.mcp_revoke_description()}
      onClose={onClose}
      role="alertdialog"
      title={m.mcp_revoke_title({ server: entry.name })}
    >
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            {m.common_cancel()}
          </Button>
          <Button disabled={revoke.isPending} onClick={submit} variant="danger">
            {m.mcp_revoke_action()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ToolsDialog({ entry, onClose }: { entry: MCPAgentServer; onClose: () => void }) {
  const tools: MCPToolSnapshot[] = entry.snapshot?.tools ?? [];
  return (
    <Dialog description={m.mcp_tools_title()} onClose={onClose} title={entry.name}>
      <div className="grid gap-3">
        <Text variant="secondary">
          {`${entry.snapshot?.protocolEra ?? "-"} · ${entry.snapshot?.protocolVersion ?? "-"}`}
        </Text>
        {entry.authorization?.toolsTruncated ? <Banner variant="alert">{m.mcp_tools_truncated()}</Banner> : null}
        {tools.length === 0 ? <Text variant="body">{m.mcp_tools_empty()}</Text> : null}
        <ul className="grid gap-2">
          {tools.map((tool) => (
            <li className="grid gap-1 rounded border border-kumo-line p-3" key={tool.name}>
              <Text variant="body">{tool.name}</Text>
              {tool.description ? <Text variant="secondary">{tool.description}</Text> : null}
              {tool.inputSchema ? (
                <Collapsible.Root>
                  <Collapsible.Trigger render={<Button size="compact" variant="ghost" />}>
                    {m.mcp_tools_column_schema()}
                    <Icon
                      className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-180"
                      name="chevron-down"
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Panel className="pt-2">
                    <pre className="overflow-x-auto text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  </Collapsible.Panel>
                </Collapsible.Root>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/**
 * The shared-definition impact sentence. One Agent reads as a name, several as a count and a list;
 * "1 Agents" is the kind of copy a reader stops trusting the rest of the page over.
 */
function describeImpact(count: number, names: string[]): string {
  const listed = names.join(", ");
  return count === 1
    ? m.mcp_edit_scope_warning_one({ agents: listed })
    : m.mcp_edit_scope_warning({ count, agents: listed });
}

// ------------------------------------------------------------------ helpers

/**
 * A bounded message for an OAuth failure. The callback never returns an `error_description`, so the
 * code is the only input, and an unknown code still produces a generic sentence.
 */
function describeOAuthError(code: string): string {
  if (code === "MCP_OAUTH_DENIED") return m.mcp_authorize_failed();
  return m.mcp_authorize_failed();
}

function describeLoadError(error: unknown): string {
  return error instanceof ApiError ? error.message : m.common_request_failed();
}

function describeActionError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

function headerRows(headers: Record<string, string>): HeaderRow[] {
  return Object.entries(headers).map(([name, value], index) => ({ id: `header-${index}-${name}`, name, value }));
}

function blankHeaderRow(): HeaderRow {
  return { id: `header-new-${blankHeaderSequence++}`, name: "", value: "" };
}

/** Monotonic within a session, so a removed row's identity is never reused by a later one. */
let blankHeaderSequence = 0;

function headersFromRows(rows: readonly HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    if (name.length > 0) headers[name] = row.value;
  }
  return headers;
}

/** A header set as an order-independent key, so reordering rows is not read as an edit. */
function sortedHeadersKey(headers: Record<string, string>): string {
  return JSON.stringify(Object.entries(headers).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function replaceRow<T>(rows: readonly T[], index: number, value: T): T[] {
  return rows.map((row, at) => (at === index ? value : row));
}

function describeHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  return entries.length === 0 ? "-" : entries.map(([name, value]) => `${name}=${value}`).join(", ");
}
