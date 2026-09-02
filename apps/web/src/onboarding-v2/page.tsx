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
import { AgentSetupPage } from "./agent-setup-page.js";
import { type AgentDraft, draftIsSubmittable, emptyDraft, type FlowState } from "./flow.js";
import "./onboarding-v2.css";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { AgentStep, DestinationStep, StepRail } from "./steps.js";

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
  onBackToAgents,
  onAgentAvailable,
  onOpenAgent,
  setupAdapter,
}: {
  accountId?: string;
  agentId?: string;
  onBackToAgents?: () => void;
  onAgentAvailable?: (agentId: string) => Promise<void> | void;
  onOpenAgent?: () => void;
  setupAdapter?: AgentSetupAdapter;
} = {}) {
  if (agentId) {
    return (
      <AgentSetupPage
        adapter={setupAdapter}
        agentId={agentId}
        onBackToAgents={onBackToAgents}
        onOpenAgent={onOpenAgent}
      />
    );
  }
  if (!accountId) throw new Error("Agent creation requires an Account id");
  return <AgentCreatePage accountId={accountId} onAgentAvailable={onAgentAvailable} onBackToAgents={onBackToAgents} />;
}

function AgentCreatePage({
  accountId,
  onAgentAvailable,
  onBackToAgents,
}: {
  accountId: string;
  onAgentAvailable?: (agentId: string) => Promise<void> | void;
  onBackToAgents?: () => void;
}) {
  useEffect(() => pruneSupersededCreationIntents(), []);
  const [pendingIntent, setPendingIntent] = useState<CreationIntentRecord | undefined>(() =>
    readCreationIntent(accountId),
  );
  const [draft, setDraft] = useState<AgentDraft>(() => draftFromIntent(pendingIntent));
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissedIntentId, setDismissedIntentId] = useState<string>();
  const createInFlightRef = useRef(false);

  const selectedRequest = useMemo<CreationIntentRequest | undefined>(() => {
    if (draft.destination !== "local" || !draftIsSubmittable(draft) || !draft.runtime) return undefined;
    const name = draft.name.trim();
    return { displayName: name, name, runtimeProvider: draft.runtime };
  }, [draft]);

  const create = useCallback(
    async (request: CreationIntentRequest, intent?: CreationIntentRecord) => {
      if (createInFlightRef.current) return;
      createInFlightRef.current = true;
      setSubmitting(true);
      setError(undefined);
      let record = intent;
      try {
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
    [accountId, onAgentAvailable],
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
    preview: false,
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
                if (selectedRequest) void create(selectedRequest);
              }}
              submitLabel={submitting ? m.agent_create_creating_action() : m.agent_create_create_agent_action()}
              submitting={submitting}
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
