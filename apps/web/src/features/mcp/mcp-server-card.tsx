import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, Icon, Tooltip } from "../../ui/design-system.js";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";
import { authorizationAction, connectorFeedback, type McpFeedback } from "./mcp-feedback.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";
import { McpServiceIcon } from "./mcp-service-icon.js";
import { mcpTitle } from "./mcp-title.js";
import { hasMcpToolSnapshot } from "./mcp-tool-snapshot.js";

export type ServerAction = "authorize" | "edit" | "delete" | "retry";

type CardProps = {
  entry: MCPAgentServer;
  onAction: (action: ServerAction) => void;
  onResume: () => void;
  resuming: boolean;
  error?: string;
  connectionError?: string;
  highlighted?: boolean;
  connecting?: boolean;
  recoveryDisabled?: boolean;
  oauthSession?: McpOAuthSession;
};

export function McpServerCard(props: CardProps) {
  const { entry, highlighted } = props;
  const connecting = Boolean(
    props.connecting ||
      props.oauthSession?.phase ||
      (entry.enabled &&
        entry.authorization?.status === "active" &&
        entry.authorization.probeState === "pending" &&
        !hasMcpToolSnapshot(entry)),
  );
  return (
    <li
      id={`mcp-server-${entry.mcpServerId}`}
      tabIndex={-1}
      className={`mcp-server-row min-w-0 p-4 outline-none focus-visible:outline-2 focus-visible:outline-kumo-focus outline-offset-[-2px] ${highlighted ? "bg-kumo-tint" : ""}`}
      data-ui="mcp-server-row"
    >
      <McpIdentity {...props} connecting={connecting} />
      <div className="mcp-server-controls">
        <McpControls {...props} checking={connecting} />
      </div>
    </li>
  );
}

function McpIdentity(props: CardProps) {
  const { entry, onAction } = props;
  const catalogEntry = findCatalogEntryByUrl(entry.effective.url, MCP_CATALOG_ENTRIES);
  const subtitle = catalogEntry
    ? localizedText(catalogEntry.description)
    : entry.description?.trim() || entry.effective.url;
  const feedback = rowFeedback(props);
  const descriptionId = `mcp-server-${entry.mcpServerId}-description`;
  return (
    <Button
      id={`mcp-server-${entry.mcpServerId}-details`}
      className="mcp-server-identity rounded-md hover:bg-kumo-tint"
      variant="ghost"
      aria-label={mcpTitle(entry)}
      aria-haspopup="dialog"
      aria-describedby={descriptionId}
      onClick={() => onAction("edit")}
    >
      <span className="mcp-server-logo">
        <McpServiceIcon src={catalogEntry?.iconIsOfficial ? catalogEntry.iconUrl : undefined} />
      </span>
      <span className="grid min-w-0 gap-1">
        <span id={`mcp-server-${entry.mcpServerId}-name`} className="mcp-server-name truncate">
          {mcpTitle(entry)}
        </span>
        <span
          id={descriptionId}
          className={`mcp-server-description line-clamp-2 whitespace-normal text-sm font-normal ${feedback.label && !feedback.neutral ? "text-kumo-danger" : "text-kumo-subtle"}`}
          role={props.error ? "alert" : undefined}
          aria-live="polite"
        >
          {feedback.label ?? subtitle}
        </span>
      </span>
    </Button>
  );
}

function McpControls(props: CardProps & { checking: boolean }) {
  const { entry, checking: connecting, resuming, onResume, onAction } = props;
  const feedback = rowFeedback({ ...props, connecting });
  const busy = Boolean(props.connecting || props.oauthSession?.phase || resuming);
  const actionLabel =
    feedback.action === "retry"
      ? m.mcp_retry()
      : entry.authorization?.kind === "bearer" && entry.authorization.hasCredential
        ? m.mcp_update_credentials()
        : authorizationAction(entry);
  return (
    <div className="mcp-server-actions">
      {!connecting && !entry.enabled ? (
        <Button
          variant="ghost"
          size="compact"
          aria-label={m.mcp_connector_action({ action: m.mcp_resume_action(), server: mcpTitle(entry) })}
          disabled={busy || props.recoveryDisabled}
          loading={resuming}
          onClick={onResume}
        >
          {m.mcp_resume_action()}
        </Button>
      ) : null}
      {!connecting && entry.enabled && feedback.action ? (
        <Button
          variant="ghost"
          size="compact"
          aria-label={m.mcp_connector_action({ action: actionLabel, server: mcpTitle(entry) })}
          disabled={props.recoveryDisabled}
          onClick={() => onAction(feedback.action === "retry" ? "retry" : "authorize")}
        >
          {actionLabel}
        </Button>
      ) : null}
      <Tooltip
        content={m.mcp_detach_action()}
        disabled={busy}
        render={
          <Button
            data-ui="mcp-remove"
            variant="ghost"
            size="compact"
            shape="square"
            className="text-kumo-subtle hover:text-kumo-danger focus-visible:text-kumo-danger"
            aria-label={m.mcp_remove_connector({ server: mcpTitle(entry) })}
            aria-haspopup="dialog"
            disabled={busy}
            onClick={() => onAction("delete")}
          />
        }
      >
        <Icon name="trash" />
      </Tooltip>
    </div>
  );
}

function rowFeedback({ entry, error, connecting, oauthSession, connectionError }: CardProps): McpFeedback {
  if (connecting) {
    const phase = oauthSession?.phase;
    const label = oauthSession?.blocked
      ? m.mcp_catalog_page_blocked()
      : phase === "waiting"
        ? m.mcp_waiting_authorization()
        : phase === "preparing"
          ? m.mcp_oauth_preparing()
          : m.mcp_checking_connection();
    return { label, neutral: true };
  }
  if (error) return { label: error };
  if (!entry.enabled) return { label: m.mcp_disabled_label(), neutral: true };
  const feedback = connectorFeedback(entry, connectionError);
  if (!feedback.label && feedback.action === "authorize")
    return { ...feedback, label: m.mcp_authorization_required(), neutral: true };
  return feedback;
}
