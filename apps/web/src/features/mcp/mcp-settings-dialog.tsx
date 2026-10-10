import { type MCPAgentServer, MCPServerUrlSchema } from "@opentag/shared/browser";
import { type ReactNode, type RefObject, useCallback, useId, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, Field, Icon, KumoInputControl } from "../../ui/design-system.js";
import { McpAuthorizeDialog } from "./mcp-authorize-dialog.js";
import { McpDialogTitle } from "./mcp-dialog-title.js";
import { McpDisclosure, McpHeaderMode, McpHeaders } from "./mcp-form.js";
import {
  actionError,
  bindingPatch,
  type ConnectionField,
  settingsDraft,
  validHeaders,
  validTokenSettings,
} from "./mcp-form-model.js";
import { useMcpServerDetail, useUpdateMcpBinding } from "./mcp-queries.js";
import { rememberMcpReturn } from "./mcp-return-context.js";
import { McpConfirmDialog, McpServerInformation } from "./mcp-server-dialogs.js";
import { McpToolsDialog } from "./mcp-tools-dialog.js";

export function McpSettingsDialog({
  agentId,
  agentName,
  entry,
  onClose,
  initialAuthentication = false,
  authenticationError,
  onRemoved,
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
  onRemoved: () => void;
  initialTools?: boolean;
  initialQuery?: string;
  initialScrollTop?: number;
}) {
  const detail = useMcpServerDetail(entry.mcpServerId);
  const update = useUpdateMcpBinding(agentId);
  const [baseline, setBaseline] = useState(entry);
  const [draft, setDraft] = useState(() => settingsDraft(entry));
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
  const [information, setInformation] = useState(false);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<HTMLButtonElement | null>(null);
  const focusKind = useRef<"auth" | "tools" | "remove">("auth");
  const scrollTop = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const attachForm = useCallback((node: HTMLFormElement | null) => {
    form.current = node;
    const dialog = node?.closest('[role="dialog"]');
    if (dialog) dialog.scrollTop = scrollTop.current;
    focusTarget.current =
      focusKind.current === "auth"
        ? authenticationTrigger.current
        : focusKind.current === "tools"
          ? toolsTrigger.current
          : removeTrigger.current;
  }, []);
  const rememberScroll = () => {
    scrollTop.current = form.current?.closest('[role="dialog"]')?.scrollTop ?? 0;
  };
  const patch = bindingPatch(baseline, draft);
  const dirty = Object.keys(patch).length > 0;
  const validUrl = MCPServerUrlSchema.safeParse(draft.url).success;
  const valid =
    validUrl &&
    validTokenSettings(draft) &&
    (draft.headerMode !== "custom" || validHeaders(draft.headers, draft.authHeader));
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
      setBaseline(saved);
      setDraft(settingsDraft(saved));
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
    if (detail.data)
      setDraft({ ...draft, [field]: detail.data.server[field], cleared: [...new Set([...draft.cleared, field])] });
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
        <p id="mcp-url-error" className="mt-1 text-xs text-kumo-danger">
          {m.mcp_url_invalid()}
        </p>
      ) : null}
      {!draft.cleared.includes(key) && (baseline.overridden[key] || draft[key] !== baseline.effective[key]) ? (
        <Button
          aria-label={m.mcp_edit_restore_field({ field: label })}
          disabled={!detail.data || detail.isError}
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
  if (removing)
    return (
      <McpConfirmDialog
        kind="remove"
        agentId={agentId}
        agentName={agentName}
        entry={entry}
        onClose={() => {
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
        onClose={back}
        onAuthorized={back}
        initialError={authError}
        onBeforeOAuth={() => rememberMcpReturn({ agentId, serverId: entry.mcpServerId, source: "edit" })}
      />
    );
  return (
    <Dialog
      busy={update.isPending}
      className="mcp-form-dialog mcp-settings-dialog"
      title={<McpDialogTitle entry={entry} title={entry.name} />}
      closeLabel={m.common_close_title({ title: entry.name })}
      description={m.mcp_settings_scope({ agent: agentName })}
      onClose={onClose}
      initialFocusRef={returnFocus.current ? focusTarget : undefined}
    >
      <form
        ref={attachForm}
        onScrollCapture={rememberScroll}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={update.isPending} className="mcp-fields border-0 p-0">
          {field("url", m.mcp_edit_url_label())}
          <SettingsUrlWarning entry={baseline} url={draft.url} />
          <div className="mcp-settings-group">
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
          </div>
          <div className="mcp-settings-group">
            <SettingsAdvanced
              draft={draft}
              setDraft={setDraft}
              field={field}
              open={advanced}
              onOpenChange={setAdvanced}
            />
            <McpDisclosure
              label={m.mcp_settings_information()}
              bordered={false}
              open={information}
              onOpenChange={setInformation}
            >
              <McpServerInformation entry={entry} />
            </McpDisclosure>
          </div>
          <Button
            ref={removeTrigger}
            className="mcp-settings-remove text-kumo-danger"
            variant="ghost"
            size="compact"
            onClick={() => {
              rememberScroll();
              setRemoving(true);
            }}
          >
            {m.mcp_detach_action()}
          </Button>
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
        <footer className="mt-5 flex flex-wrap justify-end gap-2 border-t border-kumo-line pt-4">
          <Button
            disabled={update.isPending}
            variant="ghost"
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
}: {
  draft: ReturnType<typeof settingsDraft>;
  setDraft: (draft: ReturnType<typeof settingsDraft>) => void;
  field: (key: ConnectionField, label: string, hint?: string) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
      className="mcp-settings-navigation"
      variant="ghost"
      onClick={onClick}
    >
      <span>{m.mcp_auth_label()}</span>
      <span id={statusId} className="flex min-w-0 items-center gap-2 text-sm font-normal text-kumo-subtle">
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
      className="mcp-settings-navigation"
      variant="ghost"
      aria-label={m.mcp_settings_tools()}
      aria-describedby={statusId}
      onClick={onClick}
    >
      <span>{m.mcp_settings_tools()}</span>
      <span id={statusId} className="flex items-center gap-2 text-sm font-normal text-kumo-subtle">
        {entry.snapshot ? m.mcp_tools_count({ count: entry.snapshot.tools?.length ?? 0 }) : m.mcp_tools_none_loaded()}
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
