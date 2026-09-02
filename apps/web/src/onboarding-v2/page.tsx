import type { CreateAgentRequest } from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { agentDetailLink } from "../features/agents/agent-routes.js";
import * as m from "../paraglide/messages.js";
import { Banner, Button, Icon } from "../ui/design-system.js";
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

/**
 * The Agent an already-refused name belongs to, when this Account still holds it. A read that fails
 * names nobody rather than guessing: the refusal is still true, and an offer to open the wrong Agent
 * would be worse than no offer at all.
 */
async function agentHoldingName(name: string): Promise<{ id: string; name: string } | undefined> {
  const wanted = name.trim().toLowerCase();
  return browserApi.agents().then(
    ({ agents }) => {
      const holder = agents.find(
        (candidate) => candidate.status === "active" && candidate.name.toLowerCase() === wanted,
      );
      return holder ? { id: holder.id, name: holder.name } : undefined;
    },
    () => undefined,
  );
}

/**
 * The one Agent creation/setup surface. Creation is deliberately only the short pre-Agent form;
 * as soon as the Server returns an id, the exact-Agent Issue 437 surface owns every remaining step.
 */
export function AgentSetupSurface({
  agentId,
  onBackToAgents,
  onAgentAvailable,
  onOpenAgent,
  onReady,
  reviewMode = false,
  setupAdapter,
  slackOAuthError,
}: {
  agentId?: string;
  onBackToAgents?: () => void;
  onAgentAvailable?: (agentId: string) => Promise<void> | void;
  onOpenAgent?: () => void;
  onReady?: (agentId: string) => Promise<void> | void;
  reviewMode?: boolean;
  setupAdapter?: AgentSetupAdapter;
  slackOAuthError?: string;
} = {}) {
  if (agentId) {
    return (
      <AgentSetupPage
        adapter={setupAdapter}
        agentId={agentId}
        onOpenAgent={onOpenAgent}
        onReady={onReady}
        reviewMode={reviewMode}
        slackOAuthError={slackOAuthError}
      />
    );
  }
  return <AgentCreatePage onAgentAvailable={onAgentAvailable} onBackToAgents={onBackToAgents} />;
}

function AgentCreatePage({
  onAgentAvailable,
  onBackToAgents,
}: {
  onAgentAvailable?: (agentId: string) => Promise<void> | void;
  onBackToAgents?: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  /**
   * What a refused name leaves behind: the Agent holding it when that Agent could be read, and
   * otherwise the bare fact that one exists. Both are exits, which is the point — on this route the
   * offer is the only way off the page, and it must not depend on a second request succeeding
   * immediately after one has just failed.
   */
  const [taken, setTaken] = useState<{ id: string; name: string } | "unnamed">();
  /** One creation at a time. A second press before the first answers would ask for a second Agent. */
  const createInFlight = useRef(false);

  const selectedRequest = useMemo<CreateAgentRequest | undefined>(() => {
    if (draft.destination !== "local" || !draftIsSubmittable(draft) || !draft.runtime) return undefined;
    const name = draft.name.trim();
    return { displayName: name, name, runtimeProvider: draft.runtime };
  }, [draft]);

  /*
   * Creation keeps no record of its own. A request whose answer never arrives is reconciled where
   * every other question about this Account's Agents is answered — the Agent list, which shows
   * whether the Agent exists and what it still needs. A second store here would only be a second
   * account of the same fact, and one that can disagree.
   */
  const create = useCallback(
    async (request: CreateAgentRequest) => {
      if (createInFlight.current) return;
      createInFlight.current = true;
      setSubmitting(true);
      setError(undefined);
      // Cleared with the error it belongs to: an offer left over from a previous refusal would sit
      // under a failure it does not describe.
      setTaken(undefined);
      try {
        const created = await browserApi.createAgent(request);
        await Promise.resolve(onAgentAvailable?.(created.id));
      } catch (cause) {
        setError(cause instanceof Error && cause.message ? cause.message : m.agent_create_failed());
        /*
         * A refused name is the one failure that names something the reader can go and look at.
         * The Server says only that the name is taken, so the Agent holding it is found here and
         * offered — either it is the one they meant, or the name is theirs to change. It is not
         * opened for them: an Agent this Account already has is not what Create asked for.
         *
         * The same refusal answers a request that reached the Server without its answer reaching
         * here. The reader sees the Agent their own press produced rather than a button that can
         * never work again.
         */
        if (cause instanceof ApiError && cause.code === "AGENT_NAME_CONFLICT") {
          setTaken((await agentHoldingName(request.name)) ?? "unnamed");
        }
      } finally {
        createInFlight.current = false;
        setSubmitting(false);
      }
    },
    [onAgentAvailable],
  );

  return (
    <div className="otv2-shell flex min-h-screen flex-col bg-kumo-canvas" data-ui="agent-create">
      <header className="flex items-center justify-between p-6">
        <span className="text-lg font-semibold text-kumo-strong">{m.onboarding_v2_brand_name()}</span>
        {/*
          The only way out, and only for an Account that has somewhere to go. An Account with no
          Agent has nothing behind this page: leaving would land on a list that sends it straight
          back. Undoing a choice made here is Go back's job, one page at a time.
        */}
        {onBackToAgents ? (
          <Button disabled={submitting} onClick={onBackToAgents} variant="ghost">
            {m.onboarding_v2_back_to_agents()}
          </Button>
        ) : null}
      </header>
      <main className="otv2-frame mx-auto flex w-full flex-1 flex-col items-center gap-6 p-6">
        {destinationConfirmed ? <StepRail steps={CREATE_STEPS} /> : null}
        <div className="flex w-full flex-col gap-4">
          {error ? (
            <div className="flex flex-col items-start gap-2" data-ui="agent-create-error">
              <Banner description={error} role="alert" variant="error" />
              {taken ? (
                <Link
                  className="inline-flex w-fit items-center gap-1 text-sm text-kumo-link"
                  data-ui="agent-create-open-taken-name"
                  {...(taken === "unnamed" ? { to: "/agents" } : agentDetailLink(taken.id))}
                >
                  {taken === "unnamed"
                    ? m.agent_create_open_agents()
                    : m.agent_create_open_existing({ name: taken.name })}
                  <Icon className="size-3.5" name="chevron-right" />
                </Link>
              ) : null}
            </div>
          ) : null}
          {destinationConfirmed ? (
            <AgentStep
              draft={draft}
              onBack={() => setDestinationConfirmed(false)}
              onChange={(next) => {
                // Changing the name is the other way out of a refusal, so the refusal stops being
                // shown the moment it is no longer about what the form says.
                if (next.name !== draft.name) {
                  setError(undefined);
                  setTaken(undefined);
                }
                setDraft(next);
              }}
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
