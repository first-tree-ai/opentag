import { MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import type { MCPAgentServer } from "@opentag/shared/browser";
import { useId } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, DropdownMenu, Icon, Info, Loader, Popover, Switch, Text, Tooltip } from "../../ui/design-system.js";
import { findCatalogEntryByUrl } from "./catalog/mcp-catalog-model.js";
import { canRevoke } from "./mcp-page-model.js";
import { McpServiceIcon } from "./mcp-service-icon.js";

export type ServerAction = "authorize" | "edit" | "remove" | "revoke" | "tools" | "details";
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
  const saved = entry.snapshot !== null;
  const count = entry.snapshot?.tools?.length ?? 0;
  return (
    <li
      id={`mcp-server-${entry.mcpServerId}`}
      tabIndex={-1}
      className={`mcp-server-row min-w-0 p-4 outline-offset-[-2px] ${highlighted ? "outline-2 outline-kumo-ring" : ""}`}
      data-ui="mcp-server-row"
    >
      <div className="mcp-server-identity flex min-w-0 items-center gap-3">
        <McpServiceIcon src={catalogEntry?.iconIsOfficial ? catalogEntry.iconUrl : undefined} />
        <div className="grid min-w-0 gap-1">
          <Text as="h2" title={entry.name} variant="heading">
            {entry.name}
          </Text>
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
          <ServerMenu entry={entry} pending={pending} onAction={onAction} onProbe={onProbe} />
        </div>
        <div className="mcp-server-actions flex min-w-0 items-center justify-end gap-3" aria-live="polite">
          <ToolStatus entry={entry} agentName={agentName} pending={pending} error={error} />
          {entry.enabled && !authorized ? (
            <Button size="compact" variant="secondary" onClick={() => onAction("authorize")}>
              {m.mcp_authorize_action()}
            </Button>
          ) : null}
          {entry.enabled && authorized && entry.authorization?.probeState === "failed" ? (
            <Button
              className={saved ? "px-1" : undefined}
              aria-label={m.mcp_retry()}
              disabled={pending}
              size="compact"
              variant={saved ? "ghost" : "secondary"}
              onClick={onProbe}
            >
              {m.mcp_retry()}
            </Button>
          ) : null}
          {saved ? (
            <Button className="px-1" variant="ghost" size="compact" onClick={() => onAction("tools")}>
              {m.mcp_tools_action({ count })}
              <Icon name="chevron-right" />
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
        {m.mcp_authorization_required()}
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
    const label = entry.snapshot === null ? m.mcp_row_load_failed() : m.mcp_row_refresh_failed();
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
  return null;
}
function ServerMenu({
  entry,
  pending,
  onAction,
  onProbe,
}: {
  entry: MCPAgentServer;
  pending: boolean;
  onAction: (action: ServerAction) => void;
  onProbe: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button aria-label={m.mcp_more_actions({ name: entry.name })} shape="square" size="compact" variant="ghost" />
        }
      >
        <Icon name="more-vertical" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onClick={() => onAction("edit")}>{m.mcp_edit_action()}</DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => onAction("authorize")}>{m.mcp_auth_menu()}</DropdownMenu.Item>
        {entry.enabled && entry.authorization?.status === "active" ? (
          <DropdownMenu.Item disabled={pending} onClick={onProbe}>
            {m.mcp_probe_action()}
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item onClick={() => onAction("details")}>{m.mcp_details_action()}</DropdownMenu.Item>
        <DropdownMenu.Separator />
        {canRevoke(entry) ? (
          <DropdownMenu.Item variant="danger" onClick={() => onAction("revoke")}>
            {m.mcp_revoke_action()}
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item variant="danger" onClick={() => onAction("remove")}>
          {m.mcp_detach_action()}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
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
