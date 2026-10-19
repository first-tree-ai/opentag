import { type MCPAgentServer, type MCPAuthKind, MCPServerUrlSchema } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { useMcpCatalogEntries } from "./catalog/mcp-catalog-entries.js";
import { useMcpAuthorization, validAuth } from "./mcp-authorization.js";
import { connectionAuthKind, presetAuthConfig, presetAuthKinds, settingsPreset } from "./mcp-connection-model.js";
import { connectorFeedback } from "./mcp-feedback.js";
import {
  authDraft,
  bindingPatch,
  headersFromRows,
  rebaseSettingsDraft,
  settingsDraft,
  validHeaders,
  validTokenSettings,
} from "./mcp-form-model.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";
import { useMcpServerDetail, useUpdateMcpBinding } from "./mcp-queries.js";
import type { McpReturnContext } from "./mcp-return-context.js";

export function useMcpSettings({
  agentId,
  entry,
  initialAuthentication = false,
  authenticationError,
  connectionError,
  oauthSession,
  onRetry,
  onAuthenticationFeedback,
  retrying = false,
  returnContext,
  onClose,
}: {
  agentId: string;
  agentName: string;
  entry: MCPAgentServer;
  onClose: () => void;
  initialAuthentication?: boolean;
  authenticationError?: string;
  connectionError?: string;
  oauthSession?: McpOAuthSession;
  onRetry?: () => void;
  onAuthenticationFeedback?: (label?: string) => void;
  retrying?: boolean;
  returnContext?: () => McpReturnContext;
}) {
  const catalog = useMcpCatalogEntries();
  const preset = settingsPreset(entry, catalog.entries);
  const detail = useMcpServerDetail(entry.authorization ? undefined : entry.mcpServerId);
  const authenticationReady = Boolean(entry.authorization || detail.data);
  const initialAuthOpened = useRef(false);
  const kind = entry.authorization
    ? connectionAuthKind(entry.effective.url, entry, detail.data?.server)
    : (detail.data?.server.defaultAuthKind ?? preset?.defaultAuthKind ?? "oauth");
  const [draft, setDraft] = useState(() => authDraft(entry.effective, kind));
  const [editing, setEditing] = useState(initialAuthentication && kind !== "oauth");
  useEffect(() => {
    if (
      (initialAuthentication || (kind === "none" && !entry.authorization)) &&
      authenticationReady &&
      !initialAuthOpened.current
    ) {
      initialAuthOpened.current = true;
      setEditing(kind !== "oauth");
    }
  }, [initialAuthentication, authenticationReady, kind, entry.authorization]);
  const [configuration, setConfiguration] = useState(() => ({ baseline: entry, draft: settingsDraft(entry) }));
  const [failure, setFailure] = useState<{ label: string; authentication: boolean } | undefined>(
    authenticationError ? { label: authenticationError, authentication: true } : undefined,
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const update = useUpdateMcpBinding(agentId);
  const authorization = useMcpAuthorization(agentId, oauthSession);
  useEffect(() => {
    setConfiguration((current) => ({
      baseline: entry,
      draft: rebaseSettingsDraft(current.baseline, current.draft, entry),
    }));
    if (!editing) setDraft(authDraft(entry.effective, kind));
  }, [entry, kind, editing]);
  const config = configuration.draft;
  const setConfig = (next: typeof config) => setConfiguration((current) => ({ ...current, draft: next }));
  const patch = bindingPatch(configuration.baseline, config);
  const dirty = Object.keys(patch).length > 0;
  const authEdited = editing || draft.kind !== kind;
  const configValid = authenticationReady && validConfiguration(config, draft.kind);
  const feedback = retrying
    ? { label: m.mcp_add_loading_tools(), action: "retry" as const, neutral: true }
    : connectorFeedback(entry, connectionError);
  const begin = (next: MCPAuthKind) => {
    setFailure(undefined);
    setEditing(true);
    const selected = preset ? presetAuthConfig(preset, next) : entry.effective;
    setDraft(authDraft({ ...entry.effective, ...selected }, next));
    if (preset) setConfig({ ...settingsDraft(entry), ...selected });
  };
  const cancel = () => {
    setEditing(false);
    setDraft(authDraft(entry.effective, kind));
    setConfig(settingsDraft(entry));
    setFailure(undefined);
  };
  const submitAuthentication = async () => {
    const auth = { ...draft, authHeader: config.authHeader, authScheme: config.authScheme };
    const result = await authorization.run(entry, auth, preset?.oauthScopes, {
      returnContext,
      config: {
        url: config.url,
        authHeader: config.authHeader,
        authScheme: config.authScheme,
        extraHeaders: headersFromRows(config.headers),
      },
    });
    if (result !== "redirect") {
      setEditing(false);
      setDraft((current) => ({ ...current, token: "" }));
    }
  };
  const saveConfiguration = async () => {
    if (!dirty) return;
    const saved = await update.mutateAsync({ mcpServerId: entry.mcpServerId, ...patch });
    setConfiguration({ baseline: saved, draft: settingsDraft(saved) });
    onClose();
  };
  const reportFailure = (authenticate: boolean) => {
    const label = authenticate && draft.kind === "oauth" ? m.mcp_authorization_issue() : m.mcp_save_failed();
    setFailure({ label, authentication: authenticate });
    if (authenticate && draft.kind === "oauth") onAuthenticationFeedback?.(label);
  };
  const submissionBlocked = Boolean(authorization.oauth.phase) || retrying || !configValid;
  const submit = async (forceAuth = false) => {
    if (inFlight.current || submissionBlocked) return;
    const authenticate = forceAuth || authEdited;
    const auth = { ...draft, authHeader: config.authHeader, authScheme: config.authScheme };
    if (authenticate && !validAuth(auth)) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(undefined);
    if (authenticate) onAuthenticationFeedback?.();
    try {
      if (authenticate) await submitAuthentication();
      else await saveConfiguration();
    } catch {
      reportFailure(authenticate);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const methods = preset ? presetAuthKinds(preset) : (["oauth", "bearer", "none"] as const);
  const editAuthentication = (next: typeof draft) => {
    setDraft(next);
    setEditing(true);
    setFailure(undefined);
  };
  return {
    entry,
    preset,
    authenticationReady,
    authenticationLoadFailed: !authenticationReady && detail.isError,
    retryAuthentication: () => void detail.refetch(),
    kind,
    draft,
    setDraft,
    editAuthentication,
    editing,
    busy: busy || retrying || Boolean(authorization.oauth.phase),
    onRetry,
    retrying,
    config,
    setConfig,
    dirty,
    authEdited,
    configValid,
    feedback,
    error: failure?.authentication ? undefined : failure?.label,
    authenticationError: failure?.authentication ? failure.label : undefined,
    authorization,
    begin,
    cancel,
    submit,
    methods,
  };
}

function validConfiguration(config: ReturnType<typeof settingsDraft>, kind: MCPAuthKind): boolean {
  const header = kind === "oauth" ? "authorization" : kind === "bearer" ? config.authHeader : "";
  return (
    MCPServerUrlSchema.safeParse(config.url).success &&
    validHeaders(config.headers, header) &&
    (kind !== "bearer" || validTokenSettings(config))
  );
}
