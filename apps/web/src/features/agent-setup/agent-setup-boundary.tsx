import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { browserApi } from "../../api.js";
import { forgetReboardReview, isReboardReviewFor } from "../../internal/reboard-review.js";
import { AgentSetupSurface } from "../../onboarding-v2/page.js";
import * as m from "../../paraglide/messages.js";
import { Button, Loader, Text } from "../../ui/design-system.js";
import { agentDetailLink } from "../agents/agent-routes.js";
import { Redirect } from "../navigation/redirect.js";
import { useAccount } from "../session/session-context.js";

/** An exact setup target is a uuid; anything else can never name an Agent and fails closed. */
const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActiveAgentTarget {
  displayName: string;
  id: string;
}

/**
 * How the canonical setup route resolves for this Account.
 *
 * The legal target is an active Agent owned by the Account, and ownership is proven by the
 * Account-scoped list itself: a foreign id is simply absent from it, indistinguishable from one
 * that never existed. An exact target that is missing, suspended, malformed, or someone else's
 * fails closed — it never falls back to the list, which would quietly substitute one Agent for
 * the one the link named.
 */
type TargetResolution =
  | { kind: "loading" }
  | { kind: "read-failed" }
  | { kind: "unavailable" }
  | { kind: "create" }
  | { kind: "redirect"; agentId: string }
  | { kind: "choice"; agents: readonly ActiveAgentTarget[] }
  | { kind: "exact"; agentId: string };

function resolveTargets(agentId: string | undefined, active: readonly ActiveAgentTarget[]): TargetResolution {
  if (agentId !== undefined) {
    return active.some((candidate) => candidate.id === agentId) ? { kind: "exact", agentId } : { kind: "unavailable" };
  }
  const [single] = active;
  if (active.length === 0) return { kind: "create" };
  if (active.length === 1 && single) return { agentId: single.id, kind: "redirect" };
  return { agents: active, kind: "choice" };
}

/**
 * The route boundary for canonical setup (`/agents/setup?agentId=<exact-agent>`).
 *
 * Without an `agentId` the Account's own cardinality decides: zero Agents renders the creation
 * flow, exactly one redirects to its canonical URL, and more than one asks the reader to choose
 * explicitly. `action=create` bypasses cardinality and always opens a fresh creation form.
 */
export function AgentSetupBoundary({
  action,
  agentId,
  invalidSearch = false,
  review,
  slackOAuthError,
}: {
  action?: "create";
  agentId?: string;
  invalidSearch?: boolean;
  review?: "reboard";
  slackOAuthError?: string;
}) {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const reviewMode = review === "reboard" || isReboardReviewFor(me.user.id);
  const adopt = useCallback(
    async (adoptedAgentId: string) => {
      await browserApi.completeSetup(adoptedAgentId);
      await refreshMe();
    },
    [refreshMe],
  );
  const finishReview = useCallback(async () => {
    forgetReboardReview();
    await navigate({ replace: true, to: "/agents" });
  }, [navigate]);
  const openAgent = useCallback(
    async (targetAgentId: string) => {
      await navigate(agentDetailLink(targetAgentId));
    },
    [navigate],
  );
  const backToAgents = useCallback(async () => {
    await navigate({ to: "/agents" });
  }, [navigate]);
  const openExactTarget = useCallback(
    async (createdAgentId: string) => {
      await navigate({ replace: true, search: { agentId: createdAgentId, review }, to: "/agents/setup" });
    },
    [navigate, review],
  );
  return (
    <TargetedAgentSetup
      accountId={me.user.id}
      accountCompleted={me.setupCompletedAt !== null}
      action={action}
      agentId={agentId}
      onBackToAgents={backToAgents}
      invalidSearch={invalidSearch}
      onAdopt={adopt}
      onOpenAgent={openAgent}
      onReviewFinished={finishReview}
      onTarget={openExactTarget}
      review={review}
      reviewMode={reviewMode}
      slackOAuthError={slackOAuthError}
    />
  );
}

function TargetedAgentSetup({
  accountId,
  accountCompleted,
  action,
  agentId,
  invalidSearch,
  onAdopt,
  onBackToAgents,
  onOpenAgent,
  onReviewFinished,
  onTarget,
  review,
  reviewMode,
  slackOAuthError,
}: {
  accountId: string;
  accountCompleted: boolean;
  action?: "create";
  agentId?: string;
  invalidSearch: boolean;
  onAdopt: (agentId: string) => Promise<void>;
  onBackToAgents: () => Promise<void>;
  onOpenAgent: (agentId: string) => Promise<void>;
  onReviewFinished: (agentId: string) => Promise<void>;
  onTarget: (agentId: string) => Promise<void>;
  review?: "reboard";
  reviewMode: boolean;
  slackOAuthError?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [resolution, setResolution] = useState<TargetResolution>({ kind: "loading" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the explicit retry signal; bumping it must re-run the read even though the effect body never reads it.
  useEffect(() => {
    let live = true;
    setResolution({ kind: "loading" });
    if (invalidSearch) {
      setResolution({ kind: "unavailable" });
      return () => {
        live = false;
      };
    }
    if (action === "create") {
      setResolution({ kind: "create" });
      return () => {
        live = false;
      };
    }
    // A malformed id can never become valid by asking the Server, so nothing is asked.
    if (agentId !== undefined && !AGENT_ID_PATTERN.test(agentId)) {
      setResolution({ kind: "unavailable" });
      return () => {
        live = false;
      };
    }
    void browserApi.agents().then(
      ({ agents }) => {
        if (!live) return;
        const active = agents.flatMap((candidate) =>
          candidate.status === "active" ? [{ displayName: candidate.displayName, id: candidate.id }] : [],
        );
        setResolution(resolveTargets(agentId, active));
      },
      // A failed read is not "you must be new": treating it as zero would offer a creation form
      // that ends at a name collision, so the failure is named and the read offered again.
      () => {
        if (live) setResolution({ kind: "read-failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [action, agentId, attempt, invalidSearch]);

  if (resolution.kind === "loading") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas"
        data-ui="agent-setup-target-loading"
      >
        <Loader />
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {m.agent_setup_target_loading()}
        </p>
      </div>
    );
  }

  if (resolution.kind === "read-failed") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas p-6"
        data-ui="agent-setup-target-read-failed"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.agent_setup_target_read_failed_title()}
        </Text>
        <p className="text-sm text-kumo-danger m-0 max-w-prose text-center" role="alert">
          {m.agent_setup_target_read_failed_detail()}
        </p>
        <Button onClick={() => setAttempt((current) => current + 1)}>{m.agent_setup_target_retry()}</Button>
      </div>
    );
  }

  if (resolution.kind === "unavailable") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas p-6"
        data-ui="agent-setup-target-unavailable"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.agent_setup_target_unavailable_title()}
        </Text>
        <p className="text-sm text-kumo-subtle m-0 max-w-prose text-center" role="alert">
          {m.agent_setup_target_unavailable_detail()}
        </p>
      </div>
    );
  }

  if (resolution.kind === "redirect") {
    return <Redirect replace search={{ agentId: resolution.agentId, review }} to="/agents/setup" />;
  }

  if (resolution.kind === "choice") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-kumo-canvas p-6"
        data-ui="agent-setup-target-choice"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.agent_setup_target_choice_title()}
        </Text>
        <p className="text-sm text-kumo-subtle m-0 max-w-prose text-center">{m.agent_setup_target_choice_detail()}</p>
        <ul className="grid w-full max-w-md gap-2 m-0 list-none p-0">
          {resolution.agents.map((agent) => (
            <li key={agent.id}>
              <Link
                className="block rounded-lg bg-kumo-base px-4 py-3 text-sm text-kumo-strong ring ring-kumo-line"
                search={{ agentId: agent.id, review }}
                to="/agents/setup"
              >
                {agent.displayName}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (resolution.kind === "exact") {
    return (
      <ExactAgentSetup
        accountCompleted={accountCompleted}
        agentId={resolution.agentId}
        key={resolution.agentId}
        onAdopt={onAdopt}
        onBackToAgents={onBackToAgents}
        onOpenAgent={onOpenAgent}
        onReviewFinished={onReviewFinished}
        reviewMode={reviewMode}
        slackOAuthError={slackOAuthError}
      />
    );
  }

  return (
    <AgentSetupSurface
      accountId={accountId}
      onBackToAgents={accountCompleted ? onBackToAgents : undefined}
      onAgentAvailable={onTarget}
    />
  );
}

type AdmissionState = "failed" | "loading" | "ready";

/**
 * Account admission and Agent readiness are deliberately separate. Once the boundary has proved
 * the exact active owned Agent, this component adopts it immediately; Computer, runtime, and
 * Messaging setup continue on the same canonical URL without becoming Account access gates.
 */
function ExactAgentSetup({
  accountCompleted,
  agentId,
  onAdopt,
  onBackToAgents,
  onOpenAgent,
  onReviewFinished,
  reviewMode,
  slackOAuthError,
}: {
  accountCompleted: boolean;
  agentId: string;
  onAdopt: (agentId: string) => Promise<void>;
  onBackToAgents: () => Promise<void>;
  onOpenAgent: (agentId: string) => Promise<void>;
  onReviewFinished: (agentId: string) => Promise<void>;
  reviewMode: boolean;
  slackOAuthError?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [admission, setAdmission] = useState<AdmissionState>(accountCompleted ? "ready" : "loading");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the explicit retry signal; incrementing it must repeat admission even though the value is not otherwise read.
  useEffect(() => {
    if (accountCompleted) {
      setAdmission("ready");
      return;
    }
    let live = true;
    setAdmission("loading");
    void onAdopt(agentId).then(
      () => {
        if (live) setAdmission("ready");
      },
      () => {
        if (live) setAdmission("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [accountCompleted, agentId, attempt, onAdopt]);

  if (admission === "loading") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas"
        data-ui="agent-setup-target-adopting"
      >
        <Loader />
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {m.agent_setup_target_adopting()}
        </p>
      </div>
    );
  }

  if (admission === "failed") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas p-6"
        data-ui="agent-setup-target-adoption-failed"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.agent_setup_target_adoption_failed_title()}
        </Text>
        <p className="text-sm text-kumo-danger m-0 max-w-prose text-center" role="alert">
          {m.agent_setup_target_adoption_failed_detail()}
        </p>
        <Button onClick={() => setAttempt((current) => current + 1)}>{m.agent_setup_target_retry()}</Button>
      </div>
    );
  }

  return (
    <AgentSetupSurface
      agentId={agentId}
      onBackToAgents={onBackToAgents}
      onOpenAgent={() => onOpenAgent(agentId)}
      onReady={reviewMode ? onReviewFinished : undefined}
      reviewMode={reviewMode}
      slackOAuthError={slackOAuthError}
    />
  );
}
