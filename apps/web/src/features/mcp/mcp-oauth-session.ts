import { MCP_ERROR_CODES } from "@opentag/shared/browser";
import { useEffect, useReducer, useRef } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import {
  closeMcpOAuthWindow,
  type McpOAuthWindow,
  prepareMcpOAuthWindow,
  waitMcpOAuthWindow,
} from "./mcp-oauth-window.js";
import { useMcpInvalidation, useStartMcpOAuth } from "./mcp-queries.js";
import { consumeMcpReturn, type McpReturnContext, rememberMcpReturn } from "./mcp-return-context.js";

/** Closing a view releases its rendering subscription, not an authorization already submitted. */
export function useMcpOAuthSessions(agentId: string) {
  const mutation = useStartMcpOAuth(agentId);
  const invalidate = useMcpInvalidation(agentId);
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  const sessions = useRef(new Map<string, McpOAuthSession>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
        invalidate,
      );
      sessions.current.set(key, session);
    }
    return session;
  };
}

export function useMcpOAuthSession(agentId: string) {
  return useMcpOAuthSessions(agentId)("default");
}

function createMcpOAuthSession(
  mutate: ReturnType<typeof useStartMcpOAuth>["mutateAsync"],
  refresh: () => void,
  invalidate: () => Promise<unknown>,
) {
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
  let attempt:
    | { context: McpReturnContext; state?: string; expiresAt?: string; cancellation?: Promise<boolean> }
    | undefined;
  const cancelFlow = async (): Promise<boolean> => {
    const current = attempt;
    if (!current?.state) return false;
    current.cancellation ??= browserApi
      .revokeMcpAuthorization(current.context.agentId, current.context.serverId, current.state)
      .then(() => false)
      .catch(async (error: unknown) => {
        if (!(error instanceof ApiError) || error.code !== MCP_ERROR_CODES.OAUTH_FLOW_INVALID) throw error;
        const latest = (await browserApi.agentMcpServers(current.context.agentId)).servers.find(
          (row) => row.mcpServerId === current.context.serverId,
        );
        return Boolean(latest?.authorization?.hasCredential && latest.authorization.status === "active");
      });
    return current.cancellation;
  };
  const cancel = async () => {
    interruption.current = "cancelled";
    setNotice(undefined);
    controller.current?.abort();
    fallback.current?.finish("cancelled");
    try {
      await cancelFlow();
    } catch {
      setNotice(m.mcp_setup_cleanup_failed());
    }
  };
  const start = async (context: McpReturnContext, scopes?: readonly string[], prepared?: McpOAuthWindow) => {
    const reserved = prepared ?? prepareMcpOAuthWindow();
    attempt = { context };
    const abort = new AbortController();
    controller.current = abort;
    setDetached(false);
    setNotice(undefined);
    interruption.current = undefined;
    setPhase("preparing");
    try {
      if (abort.signal.aborted) return "cancelled" as const;
      const result = await mutate({
        mcpServerId: context.serverId,
        ...(scopes?.length ? { scopes: [...scopes] } : {}),
      });
      attempt.state = new URL(result.authorizationUrl).searchParams.get("state") ?? undefined;
      attempt.expiresAt = result.expiresAt;
      const outcome = await finishAuthorization(
        result.authorizationUrl,
        { ...context, oauthState: attempt.state },
        reserved,
        abort.signal,
      );
      return outcome;
    } finally {
      abort.abort();
      closeMcpOAuthWindow(reserved.popup);
      controller.current = undefined;
      fallback.current = undefined;
      setBlocked(false);
      setPhase(undefined);
      await invalidate();
    }
  };
  async function finishAuthorization(
    url: string,
    context: McpReturnContext,
    reserved: McpOAuthWindow,
    signal: AbortSignal,
  ) {
    if (signal.aborted || reserved.popup?.closed) return cancelledResult();
    setPhase("waiting");
    const completed = reserved.popup
      ? await completeWindow(reserved.popup, url, context, signal)
      : await redirectFallback(url, context, reserved.mobile, signal);
    return completed === "cancelled" ? cancelledResult() : completed;
  }
  async function cancelledResult() {
    return (await cancelFlow()) ? ("authorized" as const) : ("cancelled" as const);
  }
  async function completeWindow(popup: Window, url: string, context: McpReturnContext, signal: AbortSignal) {
    const returned = await waitMcpOAuthWindow(popup, url, context, signal, () => setDetached(true));
    const interruption = oauthInterruption(returned);
    if (interruption) {
      // The ref is read by the calling operation after this async session settles.
      setInterruption(returned === "timeout" ? "timeout" : "cancelled");
      setNotice(returned === "timeout" ? interruption : undefined);
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
    interruption,
    get expiresAt() {
      return attempt?.expiresAt;
    },
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
