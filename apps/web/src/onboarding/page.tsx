import type { MeWorkspace, UserProfile } from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserApi } from "../api.js";
import type { OnboardingCurrentState } from "./flow.js";
import { productionRuntimeFactsAdapter, type RuntimeFactsAdapter } from "./runtime-facts.js";
import {
  type CompletionState,
  type OnboardingLoadState,
  type OnboardingSnapshot,
  OnboardingView,
  resolveSnapshot,
} from "./view.js";

/** A Computer republishes Provider readiness about twice a minute, so a slower poll loses nothing. */
const RUNTIME_POLL_INTERVAL_MS = 5_000;
const RUNTIME_POLL_LIMIT_MS = 10 * 60 * 1_000;
/** States that only an action taken outside this page can advance, and that no child polls for. */
const RUNTIME_WAIT_STATES: readonly OnboardingCurrentState["kind"][] = ["provider", "agent-runtime"];

export interface OnboardingPageProps {
  readonly membership: MeWorkspace;
  readonly onSetupReady?: (agentId: string) => Promise<void>;
  readonly onTargetAgentChange?: (agentId: string) => void;
  readonly targetAgentId?: string;
  readonly user: UserProfile;
  readonly runtimeFacts?: RuntimeFactsAdapter;
}

/**
 * Owns the whole conditional onboarding page. The page persists no step: each
 * reload starts from authoritative Workspace, Computer, Agent, runtime and handoff
 * facts, plus only the explicit route/identity choices and replay intent.
 */
export function OnboardingPage({
  membership,
  onSetupReady,
  onTargetAgentChange,
  targetAgentId,
  user,
  runtimeFacts = productionRuntimeFactsAdapter,
}: OnboardingPageProps) {
  const [revision, setRevision] = useState(0);
  const [loadState, setLoadState] = useState<OnboardingLoadState>({ kind: "loading" });
  const [refreshPending, setRefreshPending] = useState(false);
  const [attendedWindow, setAttendedWindow] = useState(0);
  const [selectedTargetAgentId, setSelectedTargetAgentId] = useState(targetAgentId);
  const [completionState, setCompletionState] = useState<CompletionState>({ kind: "idle" });
  const refreshInFlight = useRef(false);
  const completionInFlight = useRef<string | undefined>(undefined);
  const effectiveTargetAgentId = targetAgentId ?? selectedTargetAgentId;

  useEffect(() => {
    setSelectedTargetAgentId(targetAgentId);
  }, [targetAgentId]);

  const reload = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshPending(true);
    setRevision((value) => value + 1);
  }, []);
  /**
   * A refresh someone is present for: it reloads facts and restarts the bounded
   * polling window, so returning to a capped page resumes automatic progress.
   */
  const attendedReload = useCallback(() => {
    setAttendedWindow((value) => value + 1);
    reload();
  }, [reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit Server-fact reload trigger.
  useEffect(() => {
    let active = true;
    setLoadState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void loadSnapshot(membership.id, runtimeFacts, effectiveTargetAgentId).then(
      (snapshot) => {
        if (!active) return;
        refreshInFlight.current = false;
        setRefreshPending(false);
        setLoadState({ kind: "ready", snapshot });
      },
      (cause: unknown) => {
        if (!active) return;
        refreshInFlight.current = false;
        setRefreshPending(false);
        setLoadState({
          kind: "error",
          error: cause instanceof Error ? cause : new Error("Unable to load onboarding facts"),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [effectiveTargetAgentId, membership.id, revision, runtimeFacts]);

  useEffect(() => {
    const refresh = () => attendedReload();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") attendedReload();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [attendedReload]);

  const resolved = useMemo(() => {
    if (loadState.kind !== "ready") return undefined;
    return resolveSnapshot(loadState.snapshot);
  }, [loadState]);

  useEffect(() => {
    if (loadState.kind !== "ready" || !loadState.snapshot.targetAgent) return;
    const resolvedAgentId = loadState.snapshot.targetAgent.id;
    if (effectiveTargetAgentId === resolvedAgentId) return;
    setSelectedTargetAgentId(resolvedAgentId);
    onTargetAgentChange?.(resolvedAgentId);
  }, [effectiveTargetAgentId, loadState, onTargetAgentChange]);

  const completeSetup = useCallback(
    (agentId: string) => {
      if (!onSetupReady || completionInFlight.current === agentId) return;
      completionInFlight.current = agentId;
      setCompletionState({ kind: "pending" });
      void onSetupReady(agentId).catch((cause: unknown) => {
        completionInFlight.current = undefined;
        setCompletionState({
          kind: "error",
          error: cause instanceof Error ? cause : new Error("Unable to finish OpenTag setup"),
        });
      });
    },
    [onSetupReady],
  );

  useEffect(() => {
    if (resolved?.state.currentState.kind !== "ready") return;
    completeSetup(resolved.state.currentState.agent.id);
  }, [completeSetup, resolved]);
  const waitingForRuntime = resolved !== undefined && RUNTIME_WAIT_STATES.includes(resolved.state.currentState.kind);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attendedWindow deliberately restarts the bounded window.
  useEffect(() => {
    if (!waitingForRuntime) return;
    let elapsedMs = 0;
    const timer = window.setInterval(() => {
      elapsedMs += RUNTIME_POLL_INTERVAL_MS;
      // An unattended page goes quiet; the next attended refresh starts a fresh window.
      if (elapsedMs >= RUNTIME_POLL_LIMIT_MS) {
        window.clearInterval(timer);
        return;
      }
      if (document.visibilityState !== "hidden") reload();
    }, RUNTIME_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [attendedWindow, reload, waitingForRuntime]);

  return (
    <OnboardingView
      completionState={completionState}
      load={loadState}
      onAgentCreated={(agentId) => {
        setSelectedTargetAgentId(agentId);
        onTargetAgentChange?.(agentId);
      }}
      onChooseAgent={(agentId) => {
        setSelectedTargetAgentId(agentId);
        onTargetAgentChange?.(agentId);
      }}
      onCompleteSetup={completeSetup}
      onReload={attendedReload}
      onRetryLoad={reload}
      refreshPending={refreshPending}
      user={user}
      workspaceId={membership.id}
    />
  );
}

async function loadSnapshot(
  workspaceId: string,
  runtimeFacts: RuntimeFactsAdapter,
  targetAgentId?: string,
): Promise<OnboardingSnapshot> {
  const [{ computers }, { agents }] = await Promise.all([
    browserApi.computers(workspaceId),
    browserApi.agents(workspaceId),
  ]);
  const targetCandidates = agents.filter((agent) => agent.status === "active");
  const targetAgent =
    targetCandidates.find((agent) => agent.id === targetAgentId) ??
    (targetAgentId === undefined && targetCandidates.length === 1 ? targetCandidates[0] : undefined);
  const [runtime, handoff] = await Promise.all([
    runtimeFacts.load({ workspaceId, agents, computers }),
    targetAgent ? browserApi.imBindingHandoff(targetAgent.id) : Promise.resolve(undefined),
  ]);
  return { agents, computers, targetAgent, targetCandidates, handoff, runtime };
}
