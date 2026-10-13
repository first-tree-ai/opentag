import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
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
        finish: (result: "redirect" | "cancelled" | "authorized") => void;
        mobile: boolean;
        signal: AbortSignal;
        fail: (cause: unknown) => void;
        clear: () => void;
      }
    | undefined
  >(undefined);
  const [phase, setPhase] = useState<"preparing" | "waiting" | "checking">();
  const [detached, setDetached] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState<string>();
  const interruption = useRef<"cancelled" | "timeout" | undefined>(undefined);
  useEffect(
    () => () => {
      controller.current?.abort();
      fallback.current?.finish("cancelled");
    },
    [],
  );
  const cancel = () => {
    interruption.current = "cancelled";
    setNotice(m.mcp_oauth_cancelled());
    controller.current?.abort();
    fallback.current?.finish("cancelled");
  };
  const start = async (context: McpReturnContext, scopes?: readonly string[], prepared?: McpOAuthWindow) => {
    const reserved = prepared ?? prepareMcpOAuthWindow();
    const abort = new AbortController();
    controller.current = abort;
    setDetached(false);
    setNotice(undefined);
    interruption.current = undefined;
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
      if (!reserved.popup)
        return await redirectFallback(result.authorizationUrl, context, reserved.mobile, abort.signal);
      return await completeWindow(reserved.popup, result.authorizationUrl, context, abort.signal);
    } finally {
      abort.abort();
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
      // The ref is read by the calling operation after this async session settles.
      setInterruption(returned === "timeout" ? "timeout" : "cancelled");
      setNotice(interruption);
      return "cancelled" as const;
    }
    setPhase("checking");
    return "authorized" as const;
  }
  async function redirectFallback(url: string, context: McpReturnContext, mobile: boolean, signal: AbortSignal) {
    setBlocked(!mobile);
    return await new Promise<"redirect" | "cancelled" | "authorized">((resolve, reject) => {
      const timer = window.setTimeout(
        () => {
          setNotice(m.mcp_oauth_timeout());
          setInterruption("timeout");
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
      const finish = (result: "redirect" | "cancelled" | "authorized") => {
        clear();
        resolve(result);
      };
      fallback.current = {
        url,
        context,
        finish,
        mobile,
        signal,
        clear,
        fail: (cause) => {
          clear();
          reject(cause);
        },
      };
      window.addEventListener("pageshow", resumed);
      if (mobile) {
        try {
          rememberMcpReturn(context);
          window.location.assign(url);
        } catch (cause) {
          clear();
          reject(cause);
        }
      }
    });
  }
  const openFallback = async () => {
    const pending = fallback.current;
    if (!pending) return;
    if (pending.mobile) {
      rememberMcpReturn(pending.context);
      window.location.assign(pending.url);
      return;
    }
    const { popup } = prepareMcpOAuthWindow();
    if (!popup) return;
    pending.clear();
    setBlocked(false);
    try {
      const result = await completeWindow(popup, pending.url, pending.context, pending.signal);
      pending.finish(result);
    } catch (cause) {
      closeMcpOAuthWindow(popup);
      pending.fail(cause);
    }
  };
  function setInterruption(value: "cancelled" | "timeout") {
    interruption.current = value;
  }
  return { start, cancel, openFallback, phase, blocked, detached, notice, interruption };
}
export type McpOAuthSession = ReturnType<typeof useMcpOAuthSession>;

function oauthInterruption(returned: Awaited<ReturnType<typeof waitMcpOAuthWindow>>): string | undefined {
  if (returned === "timeout") return m.mcp_oauth_timeout();
  if (returned === "closed") return m.mcp_oauth_cancelled();
  if (returned.outcome.kind === "success") return undefined;
  if (returned.outcome.code === MCP_ERROR_CODES.OAUTH_DENIED) return m.mcp_oauth_cancelled();
  throw new ApiError(502, m.mcp_oauth_return_failed(), returned.outcome.code);
}
