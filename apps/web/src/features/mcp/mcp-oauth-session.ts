import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import {
  closeMcpOAuthWindow,
  type McpOAuthWindow,
  prepareMcpOAuthWindow,
  waitMcpOAuthWindow,
} from "./mcp-oauth-window.js";
import { useStartMcpOAuth } from "./mcp-queries.js";
import { consumeMcpReturn, type McpReturnContext, rememberMcpReturn } from "./mcp-return-context.js";

export function useMcpOAuthSession(agentId: string) {
  const mutation = useStartMcpOAuth(agentId);
  const controller = useRef<AbortController | undefined>(undefined);
  const fallback = useRef<
    | {
        url: string;
        context: McpReturnContext;
        finish: (result: "redirect" | "cancelled") => void;
      }
    | undefined
  >(undefined);
  const [phase, setPhase] = useState<"preparing" | "waiting" | "checking">();
  const [detached, setDetached] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<string>();
  useEffect(
    () => () => {
      controller.current?.abort();
      fallback.current?.finish("cancelled");
    },
    [],
  );
  const cancel = () => {
    setNotice(m.mcp_oauth_cancelled());
    controller.current?.abort();
    fallback.current?.finish("cancelled");
  };
  const start = async (
    context: McpReturnContext,
    scopes?: readonly string[],
    prepared?: McpOAuthWindow,
    identity?: McpOAuthIdentity,
  ) => {
    const reserved = prepared ?? prepareMcpOAuthWindow(identity);
    const abort = new AbortController();
    controller.current = abort;
    setDetached(false);
    setNotice(undefined);
    setPhase("preparing");
    try {
      const result = await mutation.mutateAsync({
        mcpServerId: context.serverId,
        ...(scopes?.length ? { scopes: [...scopes] } : {}),
      });
      if (abort.signal.aborted || reserved.popup?.closed) {
        setNotice(m.mcp_oauth_cancelled());
        return "cancelled" as const;
      }
      setPhase("waiting");
      if (!reserved.popup) return await redirectFallback(result.authorizationUrl, context, reserved.mobile);
      return await completeWindow(reserved.popup, result.authorizationUrl, context, abort.signal);
    } finally {
      closeMcpOAuthWindow(reserved.popup);
      controller.current = undefined;
      fallback.current = undefined;
      setBlocked(false);
      setPhase(undefined);
    }
  };
  async function completeWindow(popup: Window, url: string, context: McpReturnContext, signal: AbortSignal) {
    const returned = await waitMcpOAuthWindow(popup, url, context, signal, () => setDetached(true));
    const interruption = oauthInterruption(returned);
    if (interruption) {
      setNotice(interruption);
      return "cancelled" as const;
    }
    setPhase("checking");
    return "authorized" as const;
  }
  async function redirectFallback(url: string, context: McpReturnContext, mobile: boolean) {
    setBlocked(!mobile);
    return await new Promise<"redirect" | "cancelled">((resolve, reject) => {
      const timer = window.setTimeout(
        () => {
          setNotice(m.mcp_oauth_timeout());
          finish("cancelled");
        },
        10 * 60 * 1000,
      );
      const resumed = (event: PageTransitionEvent) => {
        if (!event.persisted) return;
        consumeMcpReturn(context.agentId, context.serverId);
        void cancel();
      };
      const clear = () => {
        window.clearTimeout(timer);
        window.removeEventListener("pageshow", resumed);
      };
      const finish = (result: "redirect" | "cancelled") => {
        clear();
        resolve(result);
      };
      fallback.current = { url, context, finish };
      window.addEventListener("pageshow", resumed);
      if (mobile) {
        try {
          openFallback();
        } catch (cause) {
          clear();
          reject(cause);
        }
      }
    });
  }
  const openFallback = () => {
    const pending = fallback.current;
    if (!pending) return;
    rememberMcpReturn(pending.context);
    window.location.assign(pending.url);
    // Keep loading until navigation unloads the page; Back via bfcache cancels the retained attempt.
  };
  return { start, cancel, openFallback, phase, blocked, detached, notice };
}
export type McpOAuthSession = ReturnType<typeof useMcpOAuthSession>;

function oauthInterruption(returned: Awaited<ReturnType<typeof waitMcpOAuthWindow>>): string | undefined {
  if (returned === "timeout") return m.mcp_oauth_timeout();
  if (returned === "closed") return m.mcp_oauth_cancelled();
  if (returned.outcome.kind === "success") return undefined;
  if (returned.outcome.code === MCP_ERROR_CODES.OAUTH_DENIED) return m.mcp_oauth_cancelled();
  throw new Error(m.mcp_oauth_return_failed());
}
