import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { useEffect, useReducer, useRef } from "react";
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

/** Sessions survive card filtering and remain isolated until the owning dialog unmounts. */
export function useMcpOAuthSessions(agentId: string) {
  const mutation = useStartMcpOAuth(agentId);
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  const sessions = useRef(new Map<string, McpOAuthSession>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const session of sessions.current.values()) session.dispose();
    };
  }, []);
  return (key: string) => {
    let session = sessions.current.get(key);
    if (!session) {
      session = createMcpOAuthSession(
        (input) => mutationRef.current.mutateAsync(input),
        () => {
          if (mounted.current) refresh();
        },
      );
      sessions.current.set(key, session);
    }
    return session;
  };
}

export function useMcpOAuthSession(agentId: string) {
  return useMcpOAuthSessions(agentId)("default");
}

function createMcpOAuthSession(mutate: ReturnType<typeof useStartMcpOAuth>["mutateAsync"], refresh: () => void) {
  const controller: { current: AbortController | undefined } = { current: undefined };
  const fallback: {
    current:
      | {
          url: string;
          context: McpReturnContext;
          finish: (result: "redirect" | "cancelled" | "authorized") => void;
          mobile: boolean;
          signal: AbortSignal;
          fail: (cause: unknown) => void;
          clear: () => void;
        }
      | undefined;
  } = { current: undefined };
  const state: {
    phase?: "preparing" | "waiting" | "checking";
    detached: boolean;
    blocked: boolean;
    notice?: string;
  } = { detached: false, blocked: false };
  const update = (patch: Partial<typeof state>) => {
    Object.assign(state, patch);
    refresh();
  };
  const setPhase = (phase: typeof state.phase) => update({ phase });
  const setDetached = (detached: boolean) => update({ detached });
  const setBlocked = (blocked: boolean) => update({ blocked });
  const setNotice = (notice: string | undefined) => update({ notice });
  const interruption: { current: "cancelled" | "timeout" | undefined } = { current: undefined };
  const dispose = () => {
    controller.current?.abort();
    fallback.current?.finish("cancelled");
  };
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
      const result = await mutate({
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
  return {
    start,
    cancel,
    openFallback,
    dispose,
    interruption,
    get phase() {
      return state.phase;
    },
    get blocked() {
      return state.blocked;
    },
    get detached() {
      return state.detached;
    },
    get notice() {
      return state.notice;
    },
  };
}
export type McpOAuthSession = ReturnType<typeof createMcpOAuthSession>;

function oauthInterruption(returned: Awaited<ReturnType<typeof waitMcpOAuthWindow>>): string | undefined {
  if (returned === "timeout") return m.mcp_oauth_timeout();
  if (returned === "closed") return m.mcp_oauth_cancelled();
  if (returned.outcome.kind === "success") return undefined;
  if (returned.outcome.code === MCP_ERROR_CODES.OAUTH_DENIED) return m.mcp_oauth_cancelled();
  throw new ApiError(502, m.mcp_oauth_return_failed(), returned.outcome.code);
}
