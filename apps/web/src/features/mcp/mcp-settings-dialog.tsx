import { type MCPAgentServer, type MCPServer, MCPServerUrlSchema } from "@opentag/shared/browser";
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { McpAuthorizeDialog } from "./mcp-authorize-dialog.js";
import { McpDefaultsDialog } from "./mcp-defaults-dialog.js";
import { McpDialogTitle } from "./mcp-dialog-title.js";
import { McpDisclosure, McpHeaderMode, McpHeaders } from "./mcp-form.js";
import {
  actionError,
  bindingPatch,
  type ConnectionField,
  rebaseSettingsDraft,
  settingsDraft,
  validHeaders,
  validTokenSettings,
} from "./mcp-form-model.js";
import { useMcpServerDetail, useUpdateMcpBinding } from "./mcp-queries.js";
import { rememberMcpReturn } from "./mcp-return-context.js";
import { McpConfirmDialog } from "./mcp-server-dialogs.js";
import { McpToolsDialog } from "./mcp-tools-dialog.js";

export function McpSettingsDialog({
  agentId,
  agentName,
  entry,
  onClose,
  initialAuthentication = false,
  authenticationError,
  onRemoved = onClose,
  initialTools = false,
  initialQuery,
  initialScrollTop,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
  initialAuthentication?: boolean;
  authenticationError?: string;
  onRemoved?: () => void;
  initialTools?: boolean;
  initialQuery?: string;
  initialScrollTop?: number;
}) {
  const detail = useMcpServerDetail(entry.mcpServerId);
  const update = useUpdateMcpBinding(agentId);
  const [configuration, setConfiguration] = useState(() => ({ baseline: entry, draft: settingsDraft(entry) }));
  const { baseline, draft } = configuration;
  const setDraft = (draft: typeof configuration.draft) => setConfiguration((current) => ({ ...current, draft }));
  useEffect(() => {
    setConfiguration((current) => ({
      baseline: entry,
      draft: rebaseSettingsDraft(current.baseline, current.draft, entry),
    }));
  }, [entry]);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [defaults, setDefaults] = useState<MCPServer>();
  const base = defaults ?? detail.data?.server;
  const [authentication, setAuthentication] = useState(initialAuthentication && !initialTools);
  const [authError, setAuthError] = useState(authenticationError);
  const [continueToAuth, setContinueToAuth] = useState(false);
  const [authDestination, setAuthDestination] = useState<"settings" | "tools">("settings");
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const authenticationTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [tools, setTools] = useState(initialTools);
  const [toolsAuthentication, setToolsAuthentication] = useState(initialTools && initialAuthentication);
  const [toolsContext, setToolsContext] = useState({ query: initialQuery, scrollTop: initialScrollTop });
  const [removing, setRemoving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const focusKind = useRef<"auth" | "tools" | "remove">("auth");
  const focusRefs = { auth: authenticationTrigger, tools: toolsTrigger, remove: removeTrigger };
  const scrollTop = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  const attachBody = useCallback((node: HTMLDivElement | null) => {
    body.current = node;
    if (node) node.scrollTop = scrollTop.current;
  }, []);
  const rememberScroll = () => {
    scrollTop.current = body.current?.scrollTop ?? 0;
  };
  const patch = bindingPatch(baseline, draft);
  const dirty = Object.keys(patch).length > 0;
  const validUrl = MCPServerUrlSchema.safeParse(draft.url).success;
  const valid = validSettingsDraft(draft);
  const continueAuthentication = () => {
    setContinueToAuth(false);
    if (authDestination === "tools") {
      setToolsAuthentication(true);
      setTools(true);
    } else setAuthentication(true);
  };
  const save = async () => {
    if (inFlight.current || !valid) return;
    if (!dirty) {
      if (continueToAuth) {
        continueAuthentication();
      }
      return;
    }
    inFlight.current = true;
    setError(undefined);
    try {
      const saved = await update.mutateAsync({ mcpServerId: entry.mcpServerId, ...patch });
      setConfiguration({ baseline: saved, draft: settingsDraft(saved) });
      if (continueToAuth) {
        continueAuthentication();
      } else onClose();
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
          aria-invalid={key === "url" && !validUrl}
          aria-describedby={key === "url" && !validUrl ? "mcp-url-error" : undefined}
          onChange={(event) =>
            setDraft({ ...draft, [key]: event.target.value, cleared: draft.cleared.filter((value) => value !== key) })
          }
        />
      </Field>
      {key === "url" && !validUrl ? (
        <p id="mcp-url-error" role="alert" className="mt-1 text-xs text-kumo-danger">
          {m.mcp_url_invalid()}
        </p>
      ) : null}
      {!draft.cleared.includes(key) && (baseline.overridden[key] || draft[key] !== baseline.effective[key]) ? (
        <Button
          aria-label={m.mcp_edit_restore_field({ field: label })}
          disabled={!base || detail.isError}
          className="mt-1 px-0"
          variant="ghost"
          size="compact"
          onClick={() => restore(key)}
        >
          {m.mcp_edit_restore()}
        </Button>
      ) : null}
      {draft.cleared.includes(key) ? <p className="mt-1 text-xs text-kumo-subtle">{m.mcp_edit_restored()}</p> : null}
    </div>
  );
  const back = () => {
    returnFocus.current = true;
    focusKind.current = "auth";
    setAuthError(undefined);
    setAuthentication(false);
  };
  if (defaultsOpen)
    return (
      <McpDefaultsDialog
        serverId={entry.mcpServerId}
        onClose={onClose}
        onBack={() => setDefaultsOpen(false)}
        onSaved={setDefaults}
      />
    );
  if (removing)
    return (
      <McpConfirmDialog
        kind="remove"
        agentId={agentId}
        agentName={agentName}
        entry={entry}
        onClose={onClose}
        onBack={() => {
          returnFocus.current = true;
          focusKind.current = "remove";
          setRemoving(false);
        }}
        onConfirmed={onRemoved}
      />
    );
  if (tools)
    return (
      <McpToolsDialog
        agentId={agentId}
        agentName={agentName}
        entry={entry}
        initialQuery={toolsContext.query}
        initialScrollTop={toolsContext.scrollTop}
        initialAuthentication={toolsAuthentication}
        authenticationError={authError}
        onRequestAuthentication={(query, scrollTop) => {
          if (!dirty) return false;
          setAuthError(undefined);
          setToolsContext({ query, scrollTop });
          setAuthDestination("tools");
          setContinueToAuth(true);
          setTools(false);
          returnFocus.current = true;
          focusKind.current = "tools";
          return true;
        }}
        onBack={(query, scrollTop) => {
          setAuthError(undefined);
          setToolsContext({ query, scrollTop });
          setToolsAuthentication(false);
          returnFocus.current = true;
          focusKind.current = "tools";
          setTools(false);
        }}
        onClose={onClose}
      />
    );
  if (authentication)
    return (
      <McpAuthorizeDialog
        agentId={agentId}
        agentName={agentName}
        entry={entry}
        onClose={onClose}
        onBack={back}
        onAuthorized={back}
        initialError={authError}
        onBeforeOAuth={() => rememberMcpReturn({ agentId, serverId: entry.mcpServerId, source: "edit" })}
      />
    );
  return (
    <Dialog
      busy={update.isPending}
      className="mcp-form-dialog mcp-settings-dialog"
      title={
        <span className="mcp-settings-title">
          <McpDialogTitle entry={entry} title={entry.name} />
        </span>
      }
      closeLabel={m.common_close_title({ title: entry.name })}
      onClose={onClose}
      initialFocusRef={returnFocus.current ? focusRefs[focusKind.current] : undefined}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="mcp-settings-body" ref={attachBody} onScroll={rememberScroll}>
          <fieldset disabled={update.isPending} className="mcp-fields border-0 p-0">
            {field("url", m.mcp_settings_address())}
            <SettingsUrlWarning entry={baseline} url={draft.url} />
            <div className="mcp-settings-rows">
              <SettingsAuthentication
                entry={entry}
                trigger={authenticationTrigger}
                onClick={() => {
                  rememberScroll();
                  setAuthDestination("settings");
                  if (dirty) setContinueToAuth(true);
                  else {
                    setContinueToAuth(false);
                    setAuthentication(true);
                  }
                }}
              />
              <SettingsTools
                entry={entry}
                trigger={toolsTrigger}
                onClick={() => {
                  rememberScroll();
                  setTools(true);
                }}
              />
              <SettingsAdvanced
                draft={draft}
                setDraft={setDraft}
                field={field}
                open={advanced}
                onOpenChange={setAdvanced}
                onDefaults={() => {
                  rememberScroll();
                  setDefaultsOpen(true);
                }}
              />
            </div>
          </fieldset>
          {detail.isError ? (
            <div className="mt-3">
              <p className="text-xs text-kumo-danger">{actionError(detail.error, m.common_request_failed())}</p>
              <Button size="compact" variant="ghost" onClick={() => void detail.refetch()}>
                {m.mcp_retry()}
              </Button>
            </div>
          ) : null}
          {continueToAuth ? (
            <p className="mt-4 text-sm text-kumo-subtle" role="status">
              {m.mcp_settings_save_first()}
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 text-sm text-kumo-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="mcp-settings-footer">
          <Button
            ref={removeTrigger}
            className="mcp-settings-remove"
            disabled={update.isPending}
            variant="ghost"
            onClick={() => {
              rememberScroll();
              setRemoving(true);
            }}
          >
            {m.mcp_settings_remove()}
          </Button>
          <Button
            disabled={update.isPending}
            variant="secondary"
            onClick={continueToAuth ? () => setContinueToAuth(false) : onClose}
          >
            {continueToAuth ? m.mcp_settings_keep_editing() : m.common_cancel()}
          </Button>
          <Button
            type="submit"
            disabled={update.isPending || (!dirty && !continueToAuth) || !valid}
            loading={update.isPending}
          >
            {settingsSubmitLabel(continueToAuth, dirty)}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

function SettingsAdvanced({
  draft,
  setDraft,
  field,
  open,
  onOpenChange,
  onDefaults,
}: {
  draft: ReturnType<typeof settingsDraft>;
  setDraft: (draft: ReturnType<typeof settingsDraft>) => void;
  field: (key: ConnectionField, label: string, hint?: string) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDefaults: () => void;
}) {
  return (
    <McpDisclosure label={m.mcp_settings_advanced()} bordered={false} open={open} onOpenChange={onOpenChange}>
      <div className="grid gap-4">
        <p className="text-xs leading-relaxed text-kumo-subtle">{m.mcp_settings_advanced_help()}</p>
        <div className="grid gap-3">
          <p className="text-xs text-kumo-subtle">{m.mcp_settings_token_help()}</p>
          {field("authHeader", m.mcp_edit_auth_header_label())}
          {field("authScheme", m.mcp_edit_auth_scheme_label(), m.mcp_edit_auth_scheme_help())}
        </div>
        {!validTokenSettings(draft) ? <p className="text-xs text-kumo-danger">{m.mcp_headers_invalid()}</p> : null}
        <McpHeaderMode value={draft.headerMode} onChange={(headerMode) => setDraft({ ...draft, headerMode })} />
        {draft.headerMode === "custom" ? (
          <>
            <McpHeaders rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} />
            {!validHeaders(draft.headers, draft.authHeader) ? (
              <p className="text-xs text-kumo-danger">{m.mcp_headers_invalid()}</p>
            ) : null}
          </>
        ) : null}
        <Button className="justify-self-start" variant="ghost" size="compact" onClick={onDefaults}>
          {m.mcp_defaults_action()}
          <Icon name="arrow-right" />
        </Button>
      </div>
    </McpDisclosure>
  );
}

function SettingsAuthentication({
  entry,
  trigger,
  onClick,
}: {
  entry: MCPAgentServer;
  trigger: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const connected = entry.authorization?.status === "active";
  const statusId = useId();
  return (
    <Button
      ref={trigger}
      aria-label={m.mcp_auth_label()}
      aria-describedby={statusId}
      className="mcp-settings-row"
      variant="ghost"
      onClick={onClick}
    >
      <span>{m.mcp_auth_label()}</span>
      <span id={statusId} className="mcp-settings-row-value">
        {connected ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-kumo-success" /> : null}
        {connected
          ? m.mcp_connected()
          : entry.authorization?.status === "expired"
            ? m.mcp_authorization_status_expired()
            : m.mcp_authorization_required()}
        <Icon name="chevron-right" className="size-4 shrink-0" />
      </span>
    </Button>
  );
}

function settingsSubmitLabel(continueToAuth: boolean, dirty: boolean): string {
  if (!continueToAuth) return m.mcp_edit_submit();
  return dirty ? m.mcp_settings_save_continue() : m.mcp_continue();
}

function SettingsTools({
  entry,
  trigger,
  onClick,
}: {
  entry: MCPAgentServer;
  trigger: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const statusId = useId();
  return (
    <Button
      ref={trigger}
      className="mcp-settings-row"
      variant="ghost"
      aria-label={m.mcp_settings_tools()}
      aria-describedby={statusId}
      onClick={onClick}
    >
      <span>{m.mcp_settings_tools()}</span>
      <span id={statusId} className="mcp-settings-row-value">
        {entry.snapshot
          ? entry.snapshot.tools?.length === 1
            ? m.mcp_tools_count_one()
            : m.mcp_tools_count({ count: entry.snapshot.tools?.length ?? 0 })
          : m.mcp_tools_none_loaded()}
        <Icon name="chevron-right" className="size-4 shrink-0" />
      </span>
    </Button>
  );
}
function urlRequiresAuthentication(entry: MCPAgentServer, url: string): boolean {
  return url !== entry.effective.url && entry.authorization?.kind === "oauth" && entry.authorization.hasCredential;
}

function SettingsUrlWarning({ entry, url }: { entry: MCPAgentServer; url: string }) {
  return urlRequiresAuthentication(entry, url) ? (
    <p className="text-xs text-kumo-subtle">{m.mcp_settings_url_auth_warning()}</p>
  ) : null;
}

function validSettingsDraft(draft: ReturnType<typeof settingsDraft>): boolean {
  return (
    MCPServerUrlSchema.safeParse(draft.url).success &&
    validTokenSettings(draft) &&
    (draft.headerMode !== "custom" || validHeaders(draft.headers, draft.authHeader))
  );
}
