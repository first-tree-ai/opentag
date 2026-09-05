import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CreationIntentRecord,
  type CreationIntentRequest,
  clearCreationIntent,
  createAgentOnce,
  getOrCreateCreationIntent,
  pruneSupersededCreationIntents,
  readCreationIntent,
} from "../agent-creation/creation-intent-store.js";
import { CreationRecoverySection, useCreationRecovery } from "../agent-creation/creation-recovery.js";
import { ApiError } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button } from "../ui/design-system.js";
import { AgentSetupPage, type AgentSetupPageProps } from "./agent-setup-page.js";
import { type AgentDraft, draftIsSubmittable, emptyDraft, type FlowState } from "./flow.js";
import "./onboarding-v2.css";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { AgentStep, DestinationStep, StepRail } from "./steps.js";

export type CreationPreviewView = "agent" | "destination";

const CREATE_STEPS: FlowState["steps"] = [
  { id: "agent", status: "current" },
  { id: "computer", status: "upcoming" },
  { id: "messaging", status: "upcoming" },
];

function draftFromIntent(intent: CreationIntentRecord | undefined): AgentDraft {
  if (!intent) return emptyDraft();
  return {
    ...emptyDraft(),
    destination: "local",
    name: intent.request.name,
    runtime: intent.request.runtimeProvider,
  };
}

/**
 * The one Agent creation/setup surface. Creation is deliberately only the short pre-Agent form;
 * as soon as the Server returns an id, the exact-Agent Issue 437 surface owns every remaining step.
 */
export function AgentSetupSurface({
  accountId,
  agentId,
  computerAdapter,
  creationPreview,
  creationPreviewInitialView,
  onCreationPreviewViewChange,
  onBackToAgents,
  onAgentAvailable,
  onExternalNavigation,
  onOpenAgent,
  onReady,
  refreshSignal,
  reviewMode = false,
  setupAdapter,
  slackOAuthError,
}: {
  accountId?: string;
  agentId?: string;
  computerAdapter?: AgentSetupPageProps["computerAdapter"];
  creationPreview?: (request: CreationIntentRequest) => Promise<{ readonly id: string }>;
  creationPreviewInitialView?: CreationPreviewView;
  onCreationPreviewViewChange?: (view: CreationPreviewView) => void;
  onBackToAgents?: () => void;
  onAgentAvailable?: (agentId: string) => Promise<void> | void;
  onExternalNavigation?: (url: string) => void;
  onOpenAgent?: () => void;
  onReady?: (agentId: string) => Promise<void> | void;
  refreshSignal?: number;
  reviewMode?: boolean;
  setupAdapter?: AgentSetupAdapter;
  slackOAuthError?: string;
} = {}) {
  if (agentId) {
    return (
      <AgentSetupPage
        adapter={setupAdapter}
        agentId={agentId}
        computerAdapter={computerAdapter}
        onExternalNavigation={onExternalNavigation}
        onOpenAgent={onOpenAgent}
        onReady={onReady}
        refreshSignal={refreshSignal}
        reviewMode={reviewMode}
        slackOAuthError={slackOAuthError}
      />
    );
  }
  if (!accountId) throw new Error("Agent creation requires an Account id");
  return (
    <AgentCreatePage
      accountId={accountId}
      creationPreview={creationPreview}
      creationPreviewInitialView={creationPreviewInitialView}
      onCreationPreviewViewChange={onCreationPreviewViewChange}
      onAgentAvailable={onAgentAvailable}
      onBackToAgents={onBackToAgents}
    />
  );
}

function AgentCreatePage({
  accountId,
  creationPreview,
  creationPreviewInitialView = "destination",
  onCreationPreviewViewChange,
  onAgentAvailable,
  onBackToAgents,
}: {
  accountId: string;
  creationPreview?: (request: CreationIntentRequest) => Promise<{ readonly id: string }>;
  creationPreviewInitialView?: CreationPreviewView;
  onCreationPreviewViewChange?: (view: CreationPreviewView) => void;
  onAgentAvailable?: (agentId: string) => Promise<void> | void;
  onBackToAgents?: () => void;
}) {
  useEffect(() => {
    if (!creationPreview) pruneSupersededCreationIntents();
  }, [creationPreview]);
  const [pendingIntent, setPendingIntent] = useState<CreationIntentRecord | undefined>(() =>
    creationPreview ? undefined : readCreationIntent(accountId),
  );
  const [draft, setDraft] = useState<AgentDraft>(() => {
    const initial = draftFromIntent(pendingIntent);
    return creationPreviewInitialView === "agent" ? { ...initial, destination: "local" } : initial;
  });
  const [destinationConfirmed, setDestinationConfirmed] = useState(creationPreviewInitialView === "agent");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissedIntentId, setDismissedIntentId] = useState<string>();
  const createInFlightRef = useRef(false);

  useEffect(() => {
    onCreationPreviewViewChange?.(destinationConfirmed ? "agent" : "destination");
  }, [destinationConfirmed, onCreationPreviewViewChange]);

  const selectedRequest = useMemo<CreationIntentRequest | undefined>(() => {
    if (draft.destination !== "local" || !draftIsSubmittable(draft) || !draft.runtime) return undefined;
    const name = draft.name.trim();
    return { displayName: name, name, runtimeProvider: draft.runtime };
  }, [draft]);

  const create = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the optional Lab branch preserves the production creation lifecycle unchanged.
    async (request: CreationIntentRequest, intent?: CreationIntentRecord) => {
      if (createInFlightRef.current) return;
      createInFlightRef.current = true;
      setSubmitting(true);
      setError(undefined);
      let record = intent;
      try {
        if (creationPreview) {
          const created = await creationPreview(request);
          await Promise.resolve(onAgentAvailable?.(created.id));
          return;
        }
        record ??= await getOrCreateCreationIntent(accountId, request);
        setPendingIntent(record);
        const created = await createAgentOnce(record);
        await Promise.resolve(onAgentAvailable?.(created.id));
        await clearCreationIntent(accountId, record.creationIntentId);
        setPendingIntent(undefined);
        setDismissedIntentId(record.creationIntentId);
      } catch (cause) {
        if (
          record &&
          cause instanceof ApiError &&
          (cause.category === "validation" || cause.category === "deterministic")
        ) {
          await clearCreationIntent(accountId, record.creationIntentId);
          setPendingIntent(undefined);
          setDismissedIntentId(record.creationIntentId);
        }
        setError(cause instanceof Error && cause.message ? cause.message : m.agent_create_failed());
      } finally {
        createInFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [accountId, creationPreview, onAgentAvailable],
  );

  const startOver = useCallback(() => {
    setDraft(emptyDraft());
    setDestinationConfirmed(false);
    setError(undefined);
  }, []);
  const recovery = useCreationRecovery({
    accountId,
    create,
    createInFlightRef,
    dismissedIntentId,
    onDiscarded: () => {
      setPendingIntent(undefined);
      startOver();
    },
    pendingIntent,
    preview: creationPreview !== undefined,
    selectedRequest,
    setDismissedIntentId,
    submitting,
  });

  return (
    <div className="otv2-shell flex min-h-screen flex-col bg-kumo-canvas" data-ui="agent-create">
      <header className="flex items-center justify-between p-6">
        <span className="text-lg font-semibold text-kumo-strong">{m.onboarding_v2_brand_name()}</span>
        {onBackToAgents ? (
          <Button disabled={recovery.busy} onClick={onBackToAgents} variant="ghost">
            {m.onboarding_v2_back_to_agents()}
          </Button>
        ) : destinationConfirmed ? (
          <Button disabled={recovery.busy} onClick={startOver} variant="ghost">
            {m.onboarding_v2_start_over()}
          </Button>
        ) : null}
      </header>
      <main className="otv2-frame mx-auto flex w-full flex-1 flex-col items-center gap-6 p-6">
        {destinationConfirmed ? <StepRail steps={CREATE_STEPS} /> : null}
        <div className="flex w-full flex-col gap-4">
          <CreationRecoverySection recovery={recovery} />
          {error ? <Banner description={error} role="alert" variant="error" /> : null}
          {destinationConfirmed ? (
            <AgentStep
              draft={draft}
              onBack={() => setDestinationConfirmed(false)}
              onChange={setDraft}
              onSubmit={() => {
                // A saved attempt must be resolved through Check, Retry, or Discard. Reusing it
                // through the ordinary form would make Create behave like an implicit Retry.
                if (selectedRequest && !recovery.intent) void create(selectedRequest);
              }}
              submitLabel={submitting ? m.agent_create_creating_action() : m.agent_create_create_agent_action()}
              submitting={submitting || recovery.intent !== undefined}
            />
          ) : (
            <DestinationStep
              cloudAvailable={false}
              draft={draft}
              onChoose={(destination) => setDraft({ ...draft, destination })}
              onSubmit={() => setDestinationConfirmed(true)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
