import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import { DotsThree } from "@phosphor-icons/react";
import * as m from "../../paraglide/messages.js";
import { Button, DropdownMenu, Icon, Loader, Switch, Text, Tooltip } from "../../ui/design-system.js";
import { findCatalogEntryByUrl, localizedText } from "./catalog/mcp-catalog-model.js";
import { authorizationAction, connectorFeedback } from "./mcp-feedback.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";
import { McpServiceIcon } from "./mcp-service-icon.js";
import { mcpTitle } from "./mcp-title.js";

export type ServerAction = "authorize" | "edit" | "delete";

type CardProps = {
  entry: MCPAgentServer;
  agentName: string;
  onAction: (action: ServerAction) => void;
  onProbe: () => void;
  onToggle: () => void;
  probing: boolean;
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
      <McpIdentity entry={entry} connecting={props.connecting} onDetails={() => props.onAction("edit")} />
      <div className="mcp-server-controls">
        <McpControls {...props} />
        <McpRowFeedback {...props} />
      </div>
    </li>
  );
}

function McpIdentity({
  entry,
  connecting,
  onDetails,
}: {
  entry: MCPAgentServer;
  connecting?: boolean;
  onDetails: () => void;
}) {
  const catalogEntry = findCatalogEntryByUrl(entry.effective.url, MCP_CATALOG_ENTRIES);
  const subtitle = catalogEntry
    ? localizedText(catalogEntry.description)
    : entry.description?.trim() || entry.effective.url;
  return (
    <div className="mcp-server-identity">
      <Button
        className="mcp-server-logo"
        tabIndex={-1}
        variant="ghost"
        disabled={connecting}
        aria-label={m.mcp_open_details({ server: mcpTitle(entry) })}
        onClick={() => onDetails()}
      >
        <McpServiceIcon src={catalogEntry?.iconIsOfficial ? catalogEntry.iconUrl : undefined} />
      </Button>
      <div className="grid min-w-0 gap-1">
        <Text as="h2" variant="heading" DANGEROUS_className="min-w-0">
          <Button
            id={`mcp-server-${entry.mcpServerId}-details`}
            className="mcp-server-name"
            variant="ghost"
            disabled={connecting}
            title={mcpTitle(entry)}
            onClick={() => onDetails()}
          >
            <span className="truncate">{mcpTitle(entry)}</span>
            <Icon name="chevron-right" className="size-3.5 shrink-0 text-kumo-subtle" />
          </Button>
        </Text>
        <Tooltip content={subtitle} render={<p className="truncate text-sm text-kumo-subtle" />}>
          {subtitle}
        </Tooltip>
      </div>
    </div>
  );
}

function McpControls({ entry, agentName, connecting, toggling, onToggle, onAction }: CardProps) {
  return (
    <div className="mcp-server-toggles flex shrink-0 items-center gap-2">
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
              disabled={connecting}
              aria-label={m.mcp_more_actions({ name: mcpTitle(entry) })}
            />
          }
        >
          <DotsThree aria-hidden className="size-5" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item onClick={() => onAction("edit")}>{m.mcp_details_action()}</DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => onAction("delete")}>{m.mcp_remove_action()}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  );
}

function McpRowFeedback(props: CardProps) {
  const { entry, error, connecting, probing, oauthSession, connectionError, onAction, onProbe } = props;
  if (error)
    return (
      <div className="mcp-server-actions text-sm text-kumo-danger" role="alert">
        {error}
      </div>
    );
  if (!entry.enabled) return <div className="mcp-server-actions" />;
  if (connecting || probing) return <McpBusyFeedback session={oauthSession} />;
  const feedback = connectorFeedback(entry, connectionError);
  return (
    <div className="mcp-server-actions flex min-w-0 items-center justify-end gap-3" aria-live="polite">
      {feedback.label ? (
        <span className={`mcp-server-status text-sm ${feedback.neutral ? "text-kumo-subtle" : "text-kumo-danger"}`}>
          {feedback.label}
        </span>
      ) : null}
      {feedback.action ? (
        <Button
          size="compact"
          variant="ghost"
          className="px-1 text-kumo-link"
          onClick={feedback.action === "authorize" ? () => onAction("authorize") : onProbe}
        >
          {feedback.action === "authorize" ? authorizationAction(entry) : m.mcp_retry()}
        </Button>
      ) : null}
    </div>
  );
}

function McpBusyFeedback({ session }: { session?: McpOAuthSession }) {
  const authorizing = Boolean(session?.phase && session.phase !== "checking");
  return (
    <div className="mcp-server-actions flex min-w-0 items-center justify-end gap-3" aria-live="polite">
      <span className="flex items-center gap-2 text-sm text-kumo-subtle">
        <Loader size="sm" />
        {authorizing ? m.mcp_oauth_preparing() : m.mcp_add_loading_tools()}
      </span>
      {authorizing && session ? (
        <>
          {session.blocked ? (
            <Button size="compact" variant="ghost" onClick={() => void session.openFallback()}>
              {m.mcp_catalog_open_page()}
            </Button>
          ) : null}
          <Button size="compact" variant="ghost" onClick={() => void session.cancel()}>
            {m.common_cancel()}
          </Button>
        </>
      ) : null}
    </div>
  );
}
