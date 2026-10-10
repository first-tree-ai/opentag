import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import { useId } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Icon, Info, Loader, Popover, Switch, Tooltip } from "../../ui/design-system.js";
import { findCatalogEntryByUrl } from "./catalog/mcp-catalog-model.js";
import { McpServiceIcon } from "./mcp-service-icon.js";

export type ServerAction = "authorize" | "edit";
export function McpServerCard({
  entry,
  agentName,
  onAction,
  onProbe,
  onToggle,
  probing,
  toggling,
  error,
  highlighted = false,
}: {
  entry: MCPAgentServer;
  agentName: string;
  onAction: (action: ServerAction) => void;
  onProbe: () => void;
  onToggle: () => void;
  probing: boolean;
  toggling: boolean;
  error?: string;
  highlighted?: boolean;
}) {
  const catalogEntry = findCatalogEntryByUrl(entry.effective.url, MCP_CATALOG_ENTRIES);
  const authorized = entry.authorization?.status === "active";
  const pending = probing || entry.authorization?.probeState === "pending";
  return (
    <li
      id={`mcp-server-${entry.mcpServerId}`}
      tabIndex={-1}
      className={`mcp-server-row min-w-0 p-4 outline-offset-[-2px] ${highlighted ? "outline-2 outline-kumo-ring" : ""}`}
      data-ui="mcp-server-row"
    >
      <div className="mcp-server-identity">
        <Button
          className="mcp-server-logo"
          tabIndex={-1}
          variant="ghost"
          aria-label={m.mcp_open_details({ server: entry.name })}
          onClick={() => onAction("edit")}
        >
          <McpServiceIcon src={catalogEntry?.iconIsOfficial ? catalogEntry.iconUrl : undefined} />
        </Button>
        <div className="grid min-w-0 gap-1">
          <h2 className="min-w-0">
            <Button
              id={`mcp-server-${entry.mcpServerId}-details`}
              className="mcp-server-name"
              variant="ghost"
              title={entry.name}
              onClick={() => onAction("edit")}
            >
              <span className="truncate">{entry.name}</span>
              <Icon name="chevron-right" className="size-3.5 shrink-0 text-kumo-subtle" />
            </Button>
          </h2>
          <Tooltip content={entry.effective.url} render={<p className="truncate text-sm text-kumo-subtle" />}>
            {entry.effective.url}
          </Tooltip>
        </div>
      </div>
      <div className="mcp-server-controls">
        <div className="mcp-server-toggles flex shrink-0 items-center gap-2">
          <Tooltip
            content={m.mcp_toggle_label({ agent: agentName, name: entry.name })}
            render={
              <span className="inline-flex">
                <Switch
                  aria-label={m.mcp_toggle_label({ agent: agentName, name: entry.name })}
                  checked={entry.enabled}
                  disabled={toggling}
                  transitioning={toggling}
                  onCheckedChange={onToggle}
                />
              </span>
            }
          />
        </div>
        <div className="mcp-server-actions flex min-w-0 items-center justify-end gap-3" aria-live="polite">
          <ToolStatus entry={entry} agentName={agentName} pending={pending} error={error} />
          {entry.enabled && !authorized ? (
            <Button
              size="compact"
              className="px-1 text-kumo-link"
              variant="ghost"
              onClick={() => onAction("authorize")}
            >
              {entry.authorization ? m.mcp_reconnect() : m.mcp_connect()}
            </Button>
          ) : null}
          {entry.enabled && authorized && entry.authorization?.probeState === "failed" ? (
            <Button
              className="px-1 text-kumo-link"
              aria-label={m.mcp_retry()}
              disabled={pending}
              size="compact"
              variant="ghost"
              onClick={onProbe}
            >
              {m.mcp_retry()}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
function ToolStatus({
  entry,
  agentName,
  pending,
  error,
}: {
  entry: MCPAgentServer;
  agentName: string;
  pending: boolean;
  error?: string;
}) {
  if (error) return <McpRowError key={error} label={m.mcp_row_action_failed()} error={error} defaultOpen />;
  if (!entry.enabled)
    return (
      <span
        className="mcp-server-status truncate text-sm text-kumo-subtle"
        title={m.mcp_disabled_for({ agent: agentName })}
      >
        <span className="mcp-server-status-full">{m.mcp_disabled_for({ agent: agentName })}</span>
        <span className="mcp-server-status-short">{m.mcp_mount_disabled()}</span>
      </span>
    );
  if (entry.authorization?.status !== "active")
    return (
      <span className="mcp-server-auth-status mcp-server-status flex items-center gap-2 text-sm text-kumo-subtle">
        <Info aria-hidden className="size-4 shrink-0 text-kumo-warning" />
        {m.mcp_not_connected()}
      </span>
    );
  if (pending)
    return (
      <span className="mcp-server-status flex items-center gap-2 text-sm text-kumo-subtle">
        <Loader size="sm" />
        {m.mcp_probe_state_pending()}
      </span>
    );
  if (entry.authorization.probeState === "failed") {
    const label = m.mcp_connection_failed();
    return entry.authorization.probeError ? (
      <McpRowError label={label} error={entry.authorization.probeError} />
    ) : (
      <span className="mcp-server-status text-sm text-kumo-danger">
        <span className="mcp-server-status-full">{label}</span>
        <span className="mcp-server-status-short">{m.mcp_row_failed()}</span>
      </span>
    );
  }
  if (entry.snapshot === null) return <span className="text-sm text-kumo-subtle">{m.mcp_probe_state_not_run()}</span>;
  if (entry.authorization.probeState !== "succeeded")
    return <span className="text-sm text-kumo-subtle">{m.mcp_probe_state_not_run()}</span>;
  return (
    <span className="mcp-server-status flex items-center gap-2 text-sm text-kumo-subtle">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-kumo-success" />
      {m.mcp_connected()}
    </span>
  );
}
function McpRowError({ label, error, defaultOpen = false }: { label: string; error: string; defaultOpen?: boolean }) {
  const hintId = useId();
  return (
    <Popover defaultOpen={defaultOpen}>
      <Popover.Trigger
        render={
          <Button
            aria-describedby={hintId}
            className="mcp-server-status px-0 text-kumo-danger"
            size="compact"
            variant="ghost"
          />
        }
      >
        <Info aria-hidden className="size-4 shrink-0" />
        <span className="mcp-server-status-full">{label}</span>
        <span className="mcp-server-status-short">{m.mcp_row_failed()}</span>
      </Popover.Trigger>
      <span id={hintId} className="sr-only">
        {m.mcp_error_details_hint()}
      </span>
      <Popover.Content align="end" side="top" className="z-50 max-w-xs">
        <Popover.Title>{m.mcp_error_details()}</Popover.Title>
        <p className="mt-1 text-sm">{label}</p>
        <p
          className="mt-2 wrap-anywhere whitespace-pre-wrap font-mono text-xs text-kumo-subtle"
          role={defaultOpen ? "alert" : undefined}
        >
          {error}
        </p>
      </Popover.Content>
    </Popover>
  );
}
