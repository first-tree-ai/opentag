import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { type McpOAuthOutcomeRead, readMcpOAuthOutcome } from "./mcp-oauth-outcome.js";
import { renderMcpOAuthPreparation } from "./mcp-oauth-preparation.js";

const KEY = "opentag:mcp:oauth-window";
const MAX_AGE = 10 * 60 * 1000;
type Ticket = { channel: string; agentId: string; serverId: string; savedAt: number };
export type McpOAuthWindow = { popup: Window | null; mobile: boolean };

/** A provider window without an opener must close itself after returning to our origin. */
export function closeMcpOAuthWindow(popup?: Window | null): void {
  if (!popup || popup.closed) return;
  try {
    // Reading the document tests same-origin access without attempting forbidden navigation.
    void popup.document;
  } catch {
    return;
  }
  popup.close();
}

/** Reserve during the click, before any asynchronous creation or discovery loses user activation. */
export function prepareMcpOAuthWindow(identity?: McpOAuthIdentity): McpOAuthWindow {
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  let popup: Window | null = null;
  try {
    popup = mobile ? null : window.open("", "_blank", oauthWindowFeatures());
    if (popup) renderMcpOAuthPreparation(popup, identity);
  } catch {
    closeMcpOAuthWindow(popup);
    popup = null;
    console.warn("Could not prepare the MCP authorization window.");
  }
  return { popup, mobile };
}

function oauthWindowFeatures(): string {
  const frame = Math.max(0, window.outerHeight - window.innerHeight);
  const width = Math.min(560, Math.max(320, (window.screen.availWidth || 592) - 32));
  const height = Math.min(720, Math.max(320, (window.screen.availHeight || 752 + frame) - frame - 32));
  const left = Math.round(window.screenX + ((window.outerWidth || window.innerWidth) - width) / 2);
  const top = Math.round(window.screenY + ((window.outerHeight || window.innerHeight) - height) / 2);
  return `popup,width=${width},height=${height},left=${left},top=${top}`;
}

/** BroadcastChannel survives providers severing window.opener with COOP; no credential crosses it. */
export function waitMcpOAuthWindow(
  popup: Window,
  url: string,
  target: { agentId: string; serverId: string },
  signal: AbortSignal,
  onDetached?: () => void,
): Promise<McpOAuthOutcomeRead | "closed" | "timeout"> {
  const channel = new BroadcastChannel(`opentag:mcp:${crypto.randomUUID()}`);
  const ticket: Ticket = { channel: channel.name, ...target, savedAt: Date.now() };
  return new Promise((resolve, reject) => {
    let done = false;
    let detached = false;
    let timer: number | undefined;
    const finish = (result: McpOAuthOutcomeRead | "closed" | "timeout") => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      signal.removeEventListener("abort", abort);
      channel.close();
      closeMcpOAuthWindow(popup);
      resolve(result);
    };
    const abort = () => finish("closed");
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!validOutcome(data, target.serverId)) return;
      finish(data);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      popup.sessionStorage.setItem(KEY, JSON.stringify(ticket));
      popup.opener = null;
      popup.location.replace(url);
      timer = window.setInterval(() => {
        // COOP may sever a WindowProxy while the actual provider window remains open.
        if (popup.closed && !detached) {
          detached = true;
          onDetached?.();
        }
        if (Date.now() - ticket.savedAt >= MAX_AGE) finish("timeout");
      }, 500);
      if (signal.aborted) abort();
    } catch (error) {
      signal.removeEventListener("abort", abort);
      channel.close();
      closeMcpOAuthWindow(popup);
      reject(error);
    }
  });
}

function validOutcome(value: unknown, serverId: string): value is McpOAuthOutcomeRead {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<McpOAuthOutcomeRead>;
  if (result.mcpServerId !== serverId || !result.outcome) return false;
  return (
    result.outcome.kind === "success" ||
    (result.outcome.kind === "error" && typeof result.outcome.code === "string" && result.outcome.code.length <= 256)
  );
}

/** The existing fixed callback landing page doubles as the popup's completion surface. */
export function readMcpOAuthWindowReturn(agentId: string): { ticket: Ticket; result: McpOAuthOutcomeRead } | undefined {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (!stored) return undefined;
    const ticket = JSON.parse(stored) as Partial<Ticket>;
    const elapsed = Date.now() - (ticket.savedAt ?? 0);
    if (
      ticket.agentId !== agentId ||
      typeof ticket.serverId !== "string" ||
      typeof ticket.savedAt !== "number" ||
      typeof ticket.channel !== "string" ||
      !/^opentag:mcp:[a-f0-9-]{36}$/.test(ticket.channel) ||
      elapsed < 0 ||
      elapsed > MAX_AGE
    )
      return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get("server") !== ticket.serverId) return undefined;
    const kind = params.get("mcp_oauth");
    if (kind !== "success" && kind !== "error") return undefined;
    const result: McpOAuthOutcomeRead = {
      mcpServerId: ticket.serverId,
      outcome:
        kind === "success"
          ? { kind: "success" }
          : { kind: "error", code: params.get("mcp_oauth_error") ?? "MCP_OAUTH_FAILED" },
    };
    return { ticket: ticket as Ticket, result };
  } catch {
    console.warn("Could not restore the MCP authorization window.");
    return undefined;
  }
}

export function publishMcpOAuthWindowReturn(value: { ticket: Ticket; result: McpOAuthOutcomeRead }): void {
  window.sessionStorage.removeItem(KEY);
  readMcpOAuthOutcome();
  const channel = new BroadcastChannel(value.ticket.channel);
  channel.postMessage(value.result);
  channel.close();
  window.close();
}
