import type { MCPAgentServer } from "@opentag/shared/browser";
import { formatDateTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Button, Collapsible, DropdownMenu, Icon, StatusIndicator, Switch, Text } from "../../ui/design-system.js";
import { canRevoke, type McpRowStates, rowStates } from "./mcp-page-model.js";

type ServerAction = "authorize" | "edit" | "remove" | "revoke" | "tools";

/** Mount, authorization and discovery stay independent, with controls beside the state they change. */
export function McpServerCard({
  entry,
  onAction,
  onProbe,
  onToggle,
  probing,
  toggling,
}: {
  entry: MCPAgentServer;
  onAction: (action: ServerAction) => void;
  onProbe: () => void;
  onToggle: () => void;
  probing: boolean;
  toggling: boolean;
}) {
  const states = rowStates(entry);
  const authorized = states.authorizationStatus === "active";
  const discovering = probing || (states.probe === "pending" && Boolean(entry.authorization?.probedAt));
  const canInspectTools = states.probe === "succeeded" || entry.snapshot !== null;

  return (
    <li className="grid min-w-0 gap-4 rounded-lg border border-kumo-line bg-kumo-base p-4" data-ui="mcp-server-row">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <div className="wrap-anywhere">
            <Text as="h2" variant="heading">
              {entry.name}
            </Text>
          </div>
          <p className="wrap-anywhere text-sm text-kumo-subtle">{entry.effective.url}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-kumo-subtle @min-[28rem]/content:inline">
            {entry.enabled ? m.mcp_mount_enabled() : m.mcp_mount_disabled()}
          </span>
          <Switch
            aria-label={m.mcp_toggle_label({ name: entry.name })}
            checked={entry.enabled}
            disabled={toggling}
            onCheckedChange={onToggle}
            transitioning={toggling}
          />
          <ServerMenu authorized={authorized} entry={entry} onAction={onAction} />
        </div>
      </div>

      {entry.description || entry.discoveredDescription ? (
        <p className="wrap-anywhere text-sm text-kumo-subtle">
          {entry.description || m.mcp_description_discovered({ value: entry.discoveredDescription ?? "" })}
        </p>
      ) : null}

      <AuthorizationInfo entry={entry} />
      {!entry.enabled ? (
        <Text as="p" size="sm" variant="secondary">
          {m.mcp_disabled_hint()}
        </Text>
      ) : null}

      <div className="grid gap-3 border-t border-kumo-line pt-3 @min-[36rem]/content:grid-cols-[1fr_auto] @min-[36rem]/content:items-start">
        <ToolStatus discovering={discovering} entry={entry} />
        <div className="flex flex-wrap items-center gap-2">
          {authorized && canInspectTools ? (
            <Button onClick={() => onAction("tools")} size="compact" variant="ghost">
              {m.mcp_tools_action()}
            </Button>
          ) : null}
          {!authorized ? (
            <Button onClick={() => onAction("authorize")} size="compact" variant="secondary">
              {m.mcp_authorize_action()}
            </Button>
          ) : null}
          <Button
            aria-label={m.mcp_probe_action()}
            disabled={discovering}
            loading={discovering}
            onClick={onProbe}
            size="compact"
            variant={authorized && states.probe === "failed" ? "secondary" : "ghost"}
          >
            {m.mcp_probe_action()}
          </Button>
        </div>
      </div>
    </li>
  );
}

function AuthorizationInfo({ entry }: { entry: MCPAgentServer }) {
  const states = rowStates(entry);
  const authorized = states.authorizationStatus === "active";
  const expiresAt = entry.authorization?.accessTokenExpiresAt;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-kumo-subtle">
      {states.authorizationKind !== "unauthorized" ? <span>{describeKind(states.authorizationKind)}</span> : null}
      <StatusIndicator label={describeStatus(states.authorizationStatus)} tone={authorized ? "success" : "warning"} />
      {expiresAt ? <time dateTime={expiresAt}>{m.mcp_expires_at({ time: formatDateTime(expiresAt) })}</time> : null}
    </div>
  );
}

function ToolStatus({ discovering, entry }: { discovering: boolean; entry: MCPAgentServer }) {
  const states = rowStates(entry);
  return (
    <div className="grid min-w-0 gap-2">
      <div aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusIndicator
          label={discovering ? m.mcp_probe_state_pending() : describeProbe(entry)}
          tone={states.probe === "failed" && !discovering ? "danger" : "neutral"}
        />
        {states.probe === "failed" && !discovering ? (
          <Text size="sm" variant="secondary">
            {m.mcp_discovery_failed_hint()}
          </Text>
        ) : null}
      </div>
      {entry.authorization?.probeError ? <ProbeErrorDetails error={entry.authorization.probeError} /> : null}
      {entry.authorization?.toolsTruncated ? (
        <Text as="p" size="sm" variant="secondary">
          {m.mcp_tools_truncated()}
        </Text>
      ) : null}
    </div>
  );
}

function ServerMenu({
  authorized,
  entry,
  onAction,
}: {
  authorized: boolean;
  entry: MCPAgentServer;
  onAction: (action: ServerAction) => void;
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
        {authorized ? (
          <DropdownMenu.Item onClick={() => onAction("authorize")}>{m.mcp_authorize_action()}</DropdownMenu.Item>
        ) : (
          <DropdownMenu.Item onClick={() => onAction("tools")}>{m.mcp_tools_action()}</DropdownMenu.Item>
        )}
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

function ProbeErrorDetails({ error }: { error: string }) {
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

function describeKind(kind: Exclude<McpRowStates["authorizationKind"], "unauthorized">): string {
  if (kind === "bearer") return m.mcp_authorization_bearer();
  if (kind === "oauth") return m.mcp_authorization_oauth();
  return m.mcp_authorization_anonymous();
}

function describeStatus(status: string): string {
  switch (status) {
    case "active":
      return m.mcp_authorization_status_active();
    case "pending":
      return m.mcp_authorization_status_pending();
    case "expired":
      return m.mcp_authorization_status_expired();
    case "revoked":
      return m.mcp_authorization_status_revoked();
    case "error":
      return m.mcp_authorization_status_error();
    default:
      return m.mcp_authorization_status_none();
  }
}

/**
 * The probe state as one phrase. "Never probed" and "probing right now" are different: the first
 * means the credential has not been exercised, the second means a result is on its way.
 */
function describeProbe(entry: MCPAgentServer): string {
  const authorization = entry.authorization;
  if (!authorization) return m.mcp_probe_state_not_run();
  if (authorization.probeState === "succeeded")
    return m.mcp_probe_state_succeeded({ count: authorization.toolsCount ?? 0 });
  if (authorization.probeState === "failed") return m.mcp_probe_state_failed();
  return authorization.probedAt ? m.mcp_probe_state_pending() : m.mcp_probe_state_not_run();
}
