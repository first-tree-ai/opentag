import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, DropdownMenu, Icon, Switch } from "../../ui/design-system.js";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";
import { connectorFeedback, type McpFeedback } from "./mcp-feedback.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";
import { McpServiceIcon } from "./mcp-service-icon.js";
import { mcpTitle } from "./mcp-title.js";

export type ServerAction = "authorize" | "edit" | "delete";

type CardProps = {
  entry: MCPAgentServer;
  agentName: string;
  onAction: (action: ServerAction) => void;
  onToggle: () => void;
  toggling: boolean;
  error?: string;
  connectionError?: string;
  highlighted?: boolean;
  connecting?: boolean;
  oauthSession?: McpOAuthSession;
};

export function McpServerCard(props: CardProps) {
  const { entry, highlighted } = props;
  return (
    <li
      id={`mcp-server-${entry.mcpServerId}`}
      tabIndex={-1}
      className={`mcp-server-row min-w-0 p-4 outline-none focus-visible:outline-2 focus-visible:outline-kumo-focus outline-offset-[-2px] ${highlighted ? "bg-kumo-tint" : ""}`}
      data-ui="mcp-server-row"
    >
      <McpIdentity {...props} />
      <div className="mcp-server-controls">
        <McpControls {...props} />
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
        <span className="mcp-server-name truncate">{mcpTitle(entry)}</span>
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

function McpControls({ entry, agentName, connecting, toggling, onToggle, onAction }: CardProps) {
  return (
    <div className="mcp-server-toggles flex shrink-0 items-center gap-3">
      <Switch
        aria-label={m.mcp_toggle_label({ agent: agentName, name: mcpTitle(entry) })}
        checked={entry.enabled}
        disabled={toggling || connecting}
        transitioning={toggling}
        onCheckedChange={onToggle}
      />
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button
              variant="ghost"
              shape="square"
              size="compact"
              disabled={connecting}
              aria-label={m.mcp_more_actions({ name: mcpTitle(entry) })}
            />
          }
        >
          <Icon name="more-vertical" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item onClick={() => onAction("edit")}>{m.mcp_details_action()}</DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => onAction("delete")}>{m.mcp_remove_action()}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  );
}

function rowFeedback({ entry, error, connecting, oauthSession, connectionError }: CardProps): McpFeedback {
  if (error) return { label: error };
  if (!entry.enabled) return {};
  if (connecting) {
    const authorizing = Boolean(oauthSession?.phase && oauthSession.phase !== "checking");
    return { label: authorizing ? m.mcp_oauth_preparing() : m.mcp_add_loading_tools(), neutral: true };
  }
  const feedback = connectorFeedback(entry, connectionError);
  if (!feedback.label && feedback.action === "authorize")
    return { label: m.mcp_authorization_required(), neutral: true };
  return feedback;
}
