import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { ApiError } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { Button, Icon, Loader, Tooltip } from "../../../ui/design-system.js";
import type { McpCatalogEntryState } from "./mcp-catalog-model.js";

export type McpCatalogFeedback = {
  entryId: string;
  phase: "preparing" | "waiting" | "checking" | "blocked" | "error";
  label: string;
  onCancel?: () => void;
  onOpen?: () => void;
};

export function catalogFailure(cause: unknown): string {
  if (
    (cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message)) ||
    (cause instanceof ApiError && cause.status === 0)
  )
    return m.mcp_catalog_network_error();
  if (cause instanceof ApiError && cause.code === MCP_ERROR_CODES.OAUTH_FLOW_EXPIRED)
    return m.mcp_authorization_expired();
  return m.mcp_connection_failed();
}

export function McpCatalogFeedbackActions({ feedback, title }: { feedback: McpCatalogFeedback; title: string }) {
  if (feedback.phase === "checking")
    return (
      <span aria-hidden="true">
        <Loader size="sm" className="text-kumo-link" />
      </span>
    );
  if (feedback.phase === "error") return null;
  if (feedback.phase === "blocked")
    return (
      <>
        <Button variant="ghost" size="compact" aria-label={m.mcp_oauth_open_page()} onClick={feedback.onOpen}>
          {m.mcp_catalog_open_page()}
        </Button>
        <Button
          variant="ghost"
          size="compact"
          shape="square"
          aria-label={`${m.common_cancel()}: ${title}`}
          onClick={feedback.onCancel}
        >
          <Icon name="close" />
        </Button>
      </>
    );
  return (
    <Button
      variant="ghost"
      size="compact"
      aria-label={`${m.common_cancel()}: ${title}`}
      onClick={feedback.onCancel}
      disabled={!feedback.onCancel}
    >
      <span aria-hidden="true" className="mcp-catalog-cancel-loader">
        <Loader size="sm" className="text-kumo-link" />
      </span>
      {m.common_cancel()}
    </Button>
  );
}

export function McpCatalogDescription({
  description,
  feedback,
}: {
  description: string;
  feedback?: McpCatalogFeedback;
}) {
  return (
    <p className="mcp-catalog-card-description text-sm leading-relaxed text-kumo-subtle">
      <span
        className={feedback ? "mcp-catalog-description-reserve" : undefined}
        aria-hidden={feedback ? true : undefined}
      >
        {description}
      </span>
      {feedback ? (
        <Tooltip
          content={feedback.label}
          render={
            <span
              role={feedback.phase === "error" ? "alert" : "status"}
              className={`mcp-catalog-feedback ${feedback.phase === "error" ? "text-kumo-danger" : ""}`}
            />
          }
        >
          {feedback.label}
        </Tooltip>
      ) : null}
    </p>
  );
}

export function McpCatalogActions({
  title,
  state,
  busy,
  connecting,
  pendingAction,
  feedback,
  onAdd,
}: {
  title: string;
  state: McpCatalogEntryState;
  busy: boolean;
  connecting: boolean;
  pendingAction?: "add" | "connect";
  feedback?: McpCatalogFeedback;
  onAdd: () => void;
}) {
  if (feedback && feedback.phase !== "error") return <McpCatalogFeedbackActions feedback={feedback} title={title} />;
  const failed = feedback?.phase === "error";
  if (!failed && (state === "added" || state === "disabled"))
    return (
      <span className="inline-flex min-h-8 items-center gap-1.5 text-xs text-kumo-subtle">
        <Icon name="check" />
        {state === "disabled" ? m.mcp_catalog_added() : m.mcp_catalog_connected()}
      </span>
    );
  const connect = pendingAction ? pendingAction === "connect" : state === "unconnected";
  const label = failed ? m.mcp_reconnect() : connect ? m.mcp_connect() : m.mcp_attach_action();
  const props =
    connect || failed
      ? {}
      : {
          shape: "square" as const,
          variant: "ghost" as const,
          className: "text-kumo-link hover:bg-(--brand-soft) disabled:text-kumo-subtle",
        };
  return (
    <Button
      {...props}
      aria-label={`${label}: ${title}`}
      disabled={busy}
      loading={connecting}
      size="compact"
      onClick={onAdd}
    >
      {connect || failed ? label : <Icon name="plus" className="size-5" />}
    </Button>
  );
}
