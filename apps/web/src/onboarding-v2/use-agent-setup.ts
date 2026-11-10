import type { AgentSetupAction, AgentSetupSnapshot, ImProvider } from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_SETUP_READ_TIMEOUT_MS, ApiError, CancelledRequestError, withDeadline } from "../api.js";
import { isTerminalResourceError } from "../features/resource/resource-state.js";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import { slackConfigurationMessage } from "../im/slack-configuration.js";
import * as m from "../paraglide/messages.js";
import { preparationIsTransitional } from "./preparation-readiness.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";

/** The snapshot doubles as the observation channel while the outside world is expected to move it. */
export const SETUP_POLL_MS = 2_000;
/** How many times to report readiness before the reader is offered an explicit retry. */
const READY_REPORT_ATTEMPTS = 3;
/**
 * The finite attempt cap for automatic local-preparation polls. Connected blocking snapshots
 * (`needs-runtime` or `needs-provider-clis`) share one 90s / 45-attempt read window, including
 * install, sign-in, and unavailable. Two default daemon heartbeats (30s) plus delivery margin must
 * fit inside the bound — the page must not depend on a late request after expiry. The snapshot has
 * no provenance that can tell a stale first install report from a lasting manual-action failure, so
 * GET observation continues until ready or the bound is exhausted. An explicit Check again or a new
 * mount restarts a fresh window. Changes among checking, waiting, install, sign-in, and unavailable
 * never reset the same window. Messaging/offline observation keeps its unbounded beat.
 */
export const BOUNDED_POLL_ATTEMPTS = 45;
/** Three default heartbeat periods at the 2s GET cadence, so a hung or slow read cannot stretch automatic checking. */
export const BOUNDED_POLL_WINDOW_MS = 90_000;

function boundedWindowRemaining(startedAt: { current: number | undefined }): number {
  const started = startedAt.current ?? Date.now();
  startedAt.current = started;
  return BOUNDED_POLL_WINDOW_MS - (Date.now() - started);
}

/**
 * Arms one automatic-read observation window. The window is single-flight across effect
 * restarts: an automatic read an earlier window started is awaited before a new one begins, and
 * a manual refresh, focus recovery, timeout, or unmount retires it. Bounded observation expires
 * in elapsed time even while a read is still outstanding.
 */
function armAutomaticPollWindow(
  pollClass: Exclude<SetupPollClass, undefined>,
  budget: { current: number },
  windowStartedAt: { current: number | undefined },
  inFlight: { current: Promise<boolean> | undefined },
  read: () => Promise<boolean>,
  onExhausted?: () => void,
): () => void {
  let cancelled = false;
  let timer: number | undefined;
  let expiryTimer: number | undefined;
  const exhaustAttempts = (): boolean => pollClass === "bounded" && budget.current <= 0;
  const poll = async (): Promise<void> => {
    if (cancelled) return;
    if (exhaustAttempts()) {
      onExhausted?.();
      return;
    }
    let turn = inFlight.current;
    if (turn === undefined) {
      if (pollClass === "bounded") budget.current -= 1;
      turn = read();
      inFlight.current = turn;
    }
    await turn;
    if (inFlight.current === turn) inFlight.current = undefined;
    if (cancelled) return;
    if (exhaustAttempts()) {
      onExhausted?.();
      return;
    }
    timer = window.setTimeout(() => void poll(), SETUP_POLL_MS);
  };
  if (exhaustAttempts() || (pollClass === "bounded" && boundedWindowRemaining(windowStartedAt) <= 0)) {
    onExhausted?.();
    return () => {
      cancelled = true;
    };
  }
  if (pollClass === "bounded") {
    expiryTimer = window.setTimeout(
      () => {
        if (cancelled) return;
        cancelled = true;
        window.clearTimeout(timer);
        onExhausted?.();
      },
      Math.max(0, boundedWindowRemaining(windowStartedAt)),
    );
  }
  timer = window.setTimeout(() => void poll(), SETUP_POLL_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    window.clearTimeout(expiryTimer);
  };
}

export type SetupPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "load-failed"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: AgentSetupSnapshot };

export type SetupPollClass = "bounded" | "unbounded" | undefined;

/**
 * How a snapshot the outside world is still moving should be watched. Messaging authorizing,
 * waiting-handoff, and an offline Computer keep the existing unbounded beat. Connected local
 * preparation (`needs-runtime` or `needs-provider-clis`) always uses the finite read window —
 * GET only, never `refreshPreparation` and never an automatic install. The rows stay truthful
 * while that window is open; genuine waiting/checking copy is a separate visual decision.
 */
export function snapshotPollClass(snapshot: AgentSetupSnapshot): SetupPollClass {
  if (snapshot.messaging.kind === "authorizing" || snapshot.messaging.kind === "waiting-handoff") return "unbounded";
  if (snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "offline") return "unbounded";
  if (snapshot.messaging.kind === "observation-failed") return "bounded";
  if (snapshot.stage === "needs-runtime" || snapshot.stage === "needs-provider-clis") return "bounded";
  if (snapshot.runtime.kind === "waiting") return "bounded";
  if (snapshot.runtime.kind === "observed" && snapshot.runtime.status === "checking") return "bounded";
  return undefined;
}

/** Footer spinner and "checking automatically" copy follow a real waiting/checking observation. */
export function preparationShowsAutomaticChecking(snapshot: AgentSetupSnapshot): boolean {
  if (snapshot.runtime.kind === "waiting") return true;
  if (snapshot.runtime.kind === "observed" && snapshot.runtime.status === "checking") return true;
  return preparationIsTransitional(snapshot);
}

/** A snapshot the outside world is still moving: read it again on a beat until it settles. */
export function setupSnapshotIsTransitional(snapshot: AgentSetupSnapshot): boolean {
  return snapshotPollClass(snapshot) !== undefined;
}

function setupReadError(cause: unknown): string {
  if (cause instanceof CancelledRequestError) return m.onboarding_v2_setup_load_failed();
  return cause instanceof Error && cause.message ? cause.message : m.onboarding_v2_setup_load_failed();
}

function isTerminalSetupReadError(cause: unknown): boolean {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return isTerminalResourceError(error) || (error instanceof ApiError && error.code === "AGENT_LIFECYCLE_CONFLICT");
}

export function providerTitle(provider: ImProvider): string {
  return messagingProviderLabel(provider);
}

/* One recovery message per known Server code, then a per-Provider fallback. */
export const FEISHU_ACTION_ERRORS: Record<string, () => string> = {
  FEISHU_SETUP_DENIED: () => m.im_feishu_authorization_declined({ provider: providerTitle("feishu") }),
  FEISHU_APP_IDENTITY_MISMATCH: () => m.im_feishu_authorization_mismatch({ provider: providerTitle("feishu") }),
  FEISHU_BOT_IDENTITY_MISMATCH: () => m.im_feishu_authorization_mismatch({ provider: providerTitle("feishu") }),
  FEISHU_SETUP_EXPIRED: () => m.im_feishu_authorization_expired(),
  FEISHU_SETUP_CANCELED: () => m.im_feishu_setup_canceled({ provider: providerTitle("feishu") }),
  FEISHU_SETUP_OWNER_RESTARTED: () => m.im_feishu_setup_interrupted({ provider: providerTitle("feishu") }),
  FEISHU_SETUP_CANDIDATE_EXPIRED: () => m.im_feishu_saved_authorization_expired(),
  FEISHU_CREDENTIAL_INVALID: () => m.im_feishu_saved_credential_invalid(),
  FEISHU_APP_ALREADY_BOUND: () => m.im_feishu_app_already_connected({ provider: providerTitle("feishu") }),
  FEISHU_SCOPE_REAUTH_REQUIRED: () => m.im_feishu_permissions_missing({ provider: providerTitle("feishu") }),
  IM_BINDING_SCOPE_REAUTH_REQUIRED: () => m.im_feishu_permissions_missing({ provider: providerTitle("feishu") }),
  FEISHU_UPSTREAM_UNAVAILABLE: () => m.im_feishu_unavailable({ provider: providerTitle("feishu") }),
};

function setupActionErrorMessage(action: AgentSetupAction, cause: unknown): string {
  if (cause instanceof ApiError && cause.code === "IM_BINDING_UNBIND_REQUIRED" && cause.unbindRequired) {
    return spaceScriptBoundary(
      m.onboarding_v2_setup_messaging_switch_required({
        current: providerTitle(cause.unbindRequired.currentProvider),
        requested: providerTitle(cause.unbindRequired.requestedProvider),
      }),
    );
  }
  if (action.kind === "unbind-messaging") {
    return spaceScriptBoundary(m.im_disconnect_failed({ providerName: providerTitle(action.provider) }));
  }
  if (action.kind === "cancel-messaging-attempt") {
    return spaceScriptBoundary(m.im_feishu_cancel_failed({ provider: providerTitle("feishu") }));
  }
  const provider = "provider" in action ? action.provider : undefined;
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (provider === "slack" && code) return spaceScriptBoundary(slackConfigurationMessage(code));
  const known = code && Object.hasOwn(FEISHU_ACTION_ERRORS, code) ? FEISHU_ACTION_ERRORS[code] : undefined;
  if (known) return spaceScriptBoundary(known());
  return provider === "slack"
    ? spaceScriptBoundary(m.im_slack_authorization_failed({ provider: providerTitle("slack") }))
    : spaceScriptBoundary(m.im_feishu_authorization_failed({ provider: providerTitle("feishu") }));
}

export function slackSetupErrorMessage(code: string): string {
  return spaceScriptBoundary(slackConfigurationMessage(code));
}

async function performSetupRefresh(
  adapter: AgentSetupAdapter,
  agentId: string,
  messaging?: AgentSetupSnapshot["messaging"],
): Promise<void> {
  if (messaging?.kind === "observation-failed") return;
  if (messaging?.kind === "authorizing" && messaging.provider === "feishu" && messaging.activation) {
    await adapter.checkFeishuAttempt(messaging.attemptId);
    return;
  }
  await adapter.refreshPreparation(agentId);
}

/**
 * Performs the write side of an action. `bind-computer` and `repair-computer` are absent: they
 * gate the surfaces that do the work, and those surfaces report back on their own. A Slack answer
 * is a URL to leave for; every other action is followed by a fresh read.
 */
async function performSetupAction(
  adapter: AgentSetupAdapter,
  agentId: string,
  action: AgentSetupAction,
  messaging?: AgentSetupSnapshot["messaging"],
): Promise<string | undefined> {
  switch (action.kind) {
    case "refresh":
      await performSetupRefresh(adapter, agentId, messaging);
      return undefined;
    case "start-messaging":
      if (action.provider === "feishu") {
        await adapter.startFeishuAttempt(agentId, "create", { kind: "unbound" });
        return undefined;
      }
      // The dedicated-App dialog owns new Slack connections; OAuth is recovery-only here.
      throw new Error("New messaging connections require the dedicated App dialog");
    case "cancel-messaging-attempt":
      await adapter.cancelFeishuAttempt(action.attemptId);
      return undefined;
    case "reauthorize-messaging":
      if (action.provider === "feishu") {
        await adapter.startFeishuAttempt(agentId, "reauthorize", {
          kind: "bound",
          provider: "feishu",
          bindingId: action.bindingId,
          credentialGeneration: action.credentialGeneration,
        });
        return undefined;
      }
      return adapter.startSlackInstall(agentId, "reauthorize", {
        kind: "bound",
        provider: "slack",
        bindingId: action.bindingId,
        credentialGeneration: action.credentialGeneration,
      });
    case "replace-messaging":
      await adapter.startFeishuAttempt(agentId, "replace", {
        kind: "bound",
        provider: "feishu",
        bindingId: action.bindingId,
        credentialGeneration: action.credentialGeneration,
      });
      return undefined;
    case "unbind-messaging":
      await adapter.unbindMessaging(agentId, action.provider, action.bindingId);
      return undefined;
    default:
      return undefined;
  }
}

/**
 * One numbered sequence of reads and writes per mounted target. `next` starts a read; `hold`
 * freezes the on-screen snapshot while a write is in flight; `isCurrent` lets any reply find out
 * whether something newer has already superseded it. Retired on unmount and on target change.
 */
interface RequestLifecycle {
  readonly next: () => number;
  readonly hold: () => void;
  readonly isCurrent: (ticket: number) => boolean;
}

function useRequestLifecycle(): RequestLifecycle {
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Retire everything still in flight: nothing an unmounted target asked for may land.
      generation.current += 1;
    };
  }, []);
  return useMemo(
    () => ({
      next: () => ++generation.current,
      hold: () => {
        generation.current += 1;
      },
      isCurrent: (ticket: number) => mounted.current && generation.current === ticket,
    }),
    [],
  );
}

function useSnapshotReader(
  agentId: string,
  adapter: AgentSetupAdapter,
  lifecycle: RequestLifecycle,
): { phase: SetupPhase; refreshError: string | undefined; read: () => Promise<boolean> } {
  const [phase, setPhase] = useState<SetupPhase>({ kind: "loading" });
  const [refreshError, setRefreshError] = useState<string>();
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  /*
   * A terminal answer fails closed: an Agent the Server will not show this Account is not a
   * thing to retry, and falling through to any creation path would collide with reality.
   * Over a good snapshot a failed re-read is said beside it; the snapshot itself stays put.
   */
  const failRead = useCallback((cause: unknown) => {
    if (isTerminalSetupReadError(cause)) {
      setRefreshError(undefined);
      setPhase({ kind: "unavailable" });
      return;
    }
    if (phaseRef.current.kind === "ready") setRefreshError(setupReadError(cause));
    else setPhase({ kind: "load-failed", message: setupReadError(cause) });
  }, []);

  const read = useCallback(async (): Promise<boolean> => {
    const ticket = lifecycle.next();
    try {
      const snapshot = await withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, () => adapter.readSnapshot(agentId));
      if (!lifecycle.isCurrent(ticket)) return false;
      setRefreshError(undefined);
      setPhase({ kind: "ready", snapshot });
      return true;
    } catch (cause) {
      if (!lifecycle.isCurrent(ticket)) return false;
      // A timed-out automatic re-read must settle so polling and focus can continue; the last-good
      // snapshot stays until a later read or the bounded window offers Check again.
      if (cause instanceof CancelledRequestError && phaseRef.current.kind === "ready") {
        if (phaseRef.current.snapshot.stage === "needs-messaging")
          setRefreshError(m.onboarding_v2_connection_status_timeout());
        return false;
      }
      failRead(cause);
      return false;
    }
  }, [adapter, agentId, lifecycle, failRead]);

  useEffect(() => {
    setPhase({ kind: "loading" });
    setRefreshError(undefined);
    void read();
  }, [read]);

  return { phase, refreshError, read };
}

function useSetupActions(
  agentId: string,
  adapter: AgentSetupAdapter,
  lifecycle: RequestLifecycle,
  read: () => Promise<boolean>,
  onExternalNavigation?: (url: string) => void,
  messaging?: AgentSetupSnapshot["messaging"],
): {
  actionError: string | undefined;
  busyKey: AgentSetupAction | undefined;
  act: (action: AgentSetupAction) => Promise<boolean>;
} {
  const [actionError, setActionError] = useState<string>();
  const [busyKey, setBusyKey] = useState<AgentSetupAction>();
  const busyRef = useRef(false);
  const actionRun = useRef(0);

  useEffect(() => {
    busyRef.current = false;
    return () => {
      actionRun.current += 1;
    };
  }, []);

  const act = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: action lifecycle intentionally stays atomic across navigation, refresh, and stale-tab recovery
    async (action: AgentSetupAction): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusyKey(action);
      setActionError(undefined);
      // A poll started before the write could commit the state the write just made obsolete; the
      // hold keeps the on-screen snapshot frozen until the post-action read lifts it.
      lifecycle.hold();
      const mine = ++actionRun.current;
      const live = () => actionRun.current === mine;
      try {
        const navigate = await performSetupAction(adapter, agentId, action, messaging);
        if (!live()) return false;
        if (navigate !== undefined) {
          if (onExternalNavigation) onExternalNavigation(navigate);
          else window.location.assign(navigate);
          return true;
        }
        return await read();
      } catch (cause) {
        const message =
          action.kind === "refresh" &&
          messaging?.kind === "authorizing" &&
          messaging.provider === "feishu" &&
          messaging.activation
            ? m.im_feishu_activation_check_failed()
            : setupActionErrorMessage(action, cause);
        // Another tab may have connected a Provider after this snapshot advertised a fresh start.
        // The structured conflict names that exact current binding; immediately re-read the
        // canonical snapshot so this tab replaces stale provider buttons with its unbind action.
        if (cause instanceof ApiError && cause.code === "IM_BINDING_UNBIND_REQUIRED" && cause.unbindRequired) {
          await read();
        }
        if (live()) setActionError(message);
        return false;
      } finally {
        if (live()) {
          busyRef.current = false;
          setBusyKey(undefined);
        }
      }
    },
    [adapter, agentId, lifecycle, onExternalNavigation, read, messaging],
  );

  return { actionError, busyKey, act };
}

export interface AgentSetupController {
  readonly phase: SetupPhase;
  /** A background re-read that failed over a good snapshot. The snapshot stays; this is said beside it. */
  readonly refreshError: string | undefined;
  /** The last action's failure, in words that name what was being attempted. */
  readonly actionError: string | undefined;
  /** The in-flight action identity, so loading can name the selected control while every action stays disabled. */
  readonly busyKey: AgentSetupAction | undefined;
  /** Runs one snapshot-listed action to completion and re-reads. Resolves false when it failed. */
  readonly act: (action: AgentSetupAction) => Promise<boolean>;
  /** A silent re-read, for surfaces that finished their own work (a bind, a repair). */
  readonly reload: () => void;
  /** An explicit Check again restarts the finite local-preparation observation window. */
  readonly resetPollBudget: () => void;
  /** The automatic local-preparation window ended without reaching a settled state. */
  readonly pollExhausted: boolean;
}

export function useAgentSetup(
  agentId: string,
  adapter: AgentSetupAdapter,
  onExternalNavigation?: (url: string) => void,
): AgentSetupController {
  const lifecycle = useRequestLifecycle();
  const reader = useSnapshotReader(agentId, adapter, lifecycle);
  const snapshot = reader.phase.kind === "ready" ? reader.phase.snapshot : undefined;
  const actions = useSetupActions(
    agentId,
    adapter,
    lifecycle,
    reader.read,
    onExternalNavigation,
    snapshot?.stage === "needs-messaging" || snapshot?.messaging.kind === "observation-failed"
      ? snapshot.messaging
      : undefined,
  );
  const pollClass = snapshot === undefined ? undefined : snapshotPollClass(snapshot);
  const pollBudget = useRef(BOUNDED_POLL_ATTEMPTS);
  const pollWindowStartedAt = useRef<number | undefined>(undefined);
  /**
   * The one automatic read the mounted controller allows at a time. Timeout, unmount, Check again,
   * and focus recovery retire it so a hung adapter cannot own the window indefinitely. A new poll
   * effect never starts a second automatic read while an earlier one is still in flight.
   */
  const autoPollInFlight = useRef<Promise<boolean> | undefined>(undefined);
  const [pollExhausted, setPollExhausted] = useState(false);
  // A stateful restart signal: an explicit Check again must reopen a bounded observation window
  // even when the busyKey updates around the refresh are collapsed into one render.
  const [pollRestartKey, setPollRestartKey] = useState(0);
  /** An explicit Check again or return to the page opens a fresh bounded observation window. */
  const resetPollBudget = useCallback(() => {
    pollBudget.current = BOUNDED_POLL_ATTEMPTS;
    pollWindowStartedAt.current = Date.now();
    autoPollInFlight.current = undefined;
    setPollExhausted(false);
    setPollRestartKey((value) => value + 1);
  }, []);
  // Exhaustion describes the bounded window that consumed its budget. Checking, waiting, install,
  // sign-in, and unavailable share that class, so a late shift among them must not clear the
  // paused retry. Leaving bounded observation (ready, messaging, offline) deserves a fresh window.
  // Effect restarts of the same class keep the elapsed start so they cannot silently extend it.
  useEffect(() => {
    if (pollClass === "bounded") return;
    pollBudget.current = BOUNDED_POLL_ATTEMPTS;
    pollWindowStartedAt.current = undefined;
    setPollExhausted(false);
  }, [pollClass]);
  useEffect(() => {
    return () => {
      autoPollInFlight.current = undefined;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pollRestartKey explicitly restarts the observation window.
  useEffect(() => {
    if (pollClass === undefined || actions.busyKey !== undefined) return;
    return armAutomaticPollWindow(pollClass, pollBudget, pollWindowStartedAt, autoPollInFlight, reader.read, () =>
      setPollExhausted(true),
    );
  }, [pollClass, actions.busyKey, pollRestartKey, reader.read]);

  /*
   * A window or tab returning to view re-reads the canonical snapshot: the outside world (a
   * daemon reconnect, a Runtime report, a handoff) may have moved it while the reader was away.
   * The refresh rides the same request lifecycle as every other read — a reply superseded by a
   * newer read or by an action is discarded, a transient failure over a good snapshot keeps the
   * last-good snapshot on screen — and it is skipped while an action is in flight and when no
   * snapshot is on screen yet (loading, load-failed, and unavailable keep their own manual flows).
   * A hung automatic read is retired rather than queued behind: focus burst coalescing still
   * collapses to one recovery read.
   */
  useEffect(() => {
    if (actions.busyKey !== undefined || reader.phase.kind !== "ready") return;
    let cancelled = false;
    let returnRead: Promise<boolean> | undefined;
    const refreshOnReturn = (): void => {
      if (document.visibilityState !== "visible" || returnRead !== undefined) return;
      resetPollBudget();
      const turn = reader.read();
      returnRead = turn;
      autoPollInFlight.current = turn;
      void turn.then(() => {
        if (cancelled) return;
        if (returnRead === turn) returnRead = undefined;
        if (autoPollInFlight.current === turn) autoPollInFlight.current = undefined;
      });
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    window.addEventListener("pageshow", refreshOnReturn);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      window.removeEventListener("pageshow", refreshOnReturn);
    };
  }, [actions.busyKey, reader.phase.kind, reader.read, resetPollBudget]);

  const reload = useCallback(() => void reader.read(), [reader.read]);
  return {
    ...reader,
    ...actions,
    pollExhausted: pollClass === "bounded" && pollExhausted,
    reload,
    resetPollBudget,
  };
}

export type ReadyReport = { readonly onFinish: () => void; readonly state: "failed" | "pending" | "ready" } | undefined;

/**
 * Reporting readiness once the stage is `ready`. Reported from the render that first sees it —
 * not from the button that happened to produce it — so it is true for a reader who arrives
 * already finished. Refusals get a small bounded budget, then an explicit retry.
 */
export function useReadyReport(
  snapshot: AgentSetupSnapshot | undefined,
  agentId: string,
  onReady: ((agentId: string) => Promise<void> | void) | undefined,
  reviewMode: boolean,
): ReadyReport {
  const reported = useRef<string | undefined>(undefined);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [reportFailed, setReportFailed] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  useEffect(() => {
    if (snapshot?.stage !== "ready" || !onReady) return;
    if (reported.current === agentId || reportFailed || (reviewMode && !reviewConfirmed)) return;
    // Claimed before the call so a re-render cannot report twice, and released if it fails.
    reported.current = agentId;
    let live = true;
    void Promise.resolve(onReady(agentId)).catch(() => {
      if (!live) return;
      reported.current = undefined;
      if (reportAttempt + 1 < READY_REPORT_ATTEMPTS) setReportAttempt(reportAttempt + 1);
      else setReportFailed(true);
    });
    return () => {
      live = false;
    };
  }, [snapshot?.stage, agentId, onReady, reportAttempt, reportFailed, reviewMode, reviewConfirmed]);

  if (!onReady) return undefined;
  if (reportFailed) {
    return {
      onFinish: () => {
        setReportAttempt(0);
        setReportFailed(false);
      },
      state: "failed",
    };
  }
  if (reviewMode) return { onFinish: () => setReviewConfirmed(true), state: reviewConfirmed ? "pending" : "ready" };
  return undefined;
}
