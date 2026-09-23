import type { MCPAgentServer } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import {
  Banner,
  Button,
  Collapsible,
  DropdownMenu,
  Icon,
  Loader,
  StatusIndicator,
  Switch,
  Tooltip,
} from "../../ui/design-system.js";
import { canRevoke } from "./mcp-page-model.js";
import { McpPartialTools } from "./mcp-tools-dialog.js";

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
  const authorized = entry.authorization?.status === "active";
  const pending = probing || entry.authorization?.probeState === "pending";
  const saved = entry.snapshot?.tools != null;
  const previous = !authorized || entry.authorization?.probeState !== "succeeded" || probing;
  return (
    <li
      id={`mcp-server-${entry.mcpServerId}`}
      tabIndex={-1}
      className={`grid min-w-0 gap-3 rounded-lg border border-kumo-line bg-kumo-base p-5 outline-offset-4 ${highlighted ? "outline-2 outline-kumo-ring" : ""}`}
      data-ui="mcp-server-row"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="wrap-anywhere text-base font-semibold">{entry.name}</h2>
          <p className="wrap-anywhere text-sm text-kumo-subtle">{entry.effective.url}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          <ServerMenu entry={entry} onAction={onAction} />
        </div>
      </div>
      {entry.description ? (
        <p className="wrap-anywhere line-clamp-2 text-sm text-kumo-subtle">{entry.description}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
        <div className="min-w-0" aria-live="polite">
          <ToolStatus entry={entry} agentName={agentName} pending={pending} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saved ? (
            <Button variant="ghost" size="compact" onClick={() => onAction("tools")}>
              {previous ? m.mcp_saved_tools_action() : m.mcp_tools_action()}
            </Button>
          ) : null}
          {entry.enabled && !authorized ? (
            <Button size="compact" variant="secondary" onClick={() => onAction("authorize")}>
              {m.mcp_authorize_action()}
            </Button>
          ) : null}
          {entry.enabled && authorized && entry.authorization?.probeState === "failed" && !pending ? (
            <Button size="compact" variant="secondary" onClick={onProbe}>
              {m.mcp_retry()}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <Banner variant="error">{error}</Banner> : null}
      {entry.enabled &&
      authorized &&
      entry.authorization?.probeState === "failed" &&
      !pending &&
      entry.authorization.probeError ? (
        <McpProbeError error={entry.authorization.probeError} />
      ) : null}
    </li>
  );
}
function ToolStatus({ entry, agentName, pending }: { entry: MCPAgentServer; agentName: string; pending: boolean }) {
  if (!entry.enabled)
    return <span className="text-sm text-kumo-subtle">{m.mcp_disabled_for({ agent: agentName })}</span>;
  if (entry.authorization?.status !== "active")
    return <StatusIndicator label={m.mcp_authorization_required()} tone="warning" />;
  if (pending)
    return (
      <span className="flex items-center gap-2 text-sm text-kumo-subtle">
        <Loader size="sm" />
        {entry.authorization.kind === "oauth" ? m.mcp_probe_oauth_pending() : m.mcp_probe_state_pending()}
      </span>
    );
  if (entry.authorization.probeState === "failed")
    return <span className="text-sm text-kumo-danger">{m.mcp_probe_state_failed()}</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-sm">
        {m.mcp_probe_state_succeeded({ count: entry.authorization.toolsCount ?? entry.snapshot?.tools?.length ?? 0 })}
      </span>
      {entry.authorization.toolsTruncated ? <McpPartialTools /> : null}
    </div>
  );
}
function ServerMenu({ entry, onAction }: { entry: MCPAgentServer; onAction: (action: ServerAction) => void }) {
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
export function McpProbeError({ error }: { error: string }) {
  return (
    <Collapsible.Root className="min-w-0">
      <Collapsible.Trigger render={<Button className="text-kumo-subtle" size="compact" variant="ghost" />}>
        {m.mcp_error_details()}
        <Icon className="size-3.5" name="chevron-down" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="pt-2">
        <p className="wrap-anywhere whitespace-pre-wrap rounded bg-kumo-recessed p-3 font-mono text-xs text-kumo-subtle">
          {error}
        </p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
