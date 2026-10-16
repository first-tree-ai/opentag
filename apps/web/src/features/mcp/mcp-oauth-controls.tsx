import * as m from "../../paraglide/messages.js";
import { Button } from "../../ui/design-system.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";

export function McpOAuthControls({ session, className = "" }: { session: McpOAuthSession; className?: string }) {
  if (!session.phase && !session.notice) return null;
  return (
    <div className={`grid gap-2 ${className}`} aria-live="polite">
      {session.detached && session.phase === "waiting" ? (
        <p className="text-sm text-kumo-subtle">{m.mcp_oauth_window_detached()}</p>
      ) : null}
      {session.notice ? <p className="text-sm text-kumo-subtle">{session.notice}</p> : null}
      {session.phase ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-kumo-subtle">{phaseLabel(session)}</span>
          {session.blocked ? <Button onClick={session.openFallback}>{m.mcp_oauth_open_page()}</Button> : null}
          {session.phase !== "checking" ? (
            <Button variant="ghost" onClick={() => void session.cancel()}>
              {m.common_cancel()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function phaseLabel(session: McpOAuthSession): string {
  if (session.blocked) return m.mcp_oauth_window_blocked();
  if (session.phase === "waiting") return m.mcp_oauth_waiting();
  if (session.phase === "checking") return m.mcp_oauth_checking();
  return m.mcp_oauth_preparing();
}
