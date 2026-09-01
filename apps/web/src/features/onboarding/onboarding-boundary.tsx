import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { forgetReboardReview, isReboardReviewFor } from "../../internal/reboard-review.js";
import { OnboardingV2Page } from "../../onboarding-v2/page.js";
import * as m from "../../paraglide/messages.js";
import { Button, Loader, Text } from "../../ui/design-system.js";
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
  | { kind: "exact" };

function resolveTargets(agentId: string | undefined, active: readonly ActiveAgentTarget[]): TargetResolution {
  if (agentId !== undefined) {
    return active.some((candidate) => candidate.id === agentId) ? { kind: "exact" } : { kind: "unavailable" };
  }
  const [single] = active;
  if (active.length === 0) return { kind: "create" };
  if (active.length === 1 && single) return { agentId: single.id, kind: "redirect" };
  return { agents: active, kind: "choice" };
}

/**
 * The exact-target route boundary for canonical setup (`/onboarding?agentId=<exact-agent>`).
 *
 * Without an `agentId` the Account's own cardinality decides: zero Agents renders the creation
 * flow, exactly one redirects to its canonical URL, and more than one asks the reader to choose
 * explicitly. A completed Account that arrives without a target is sent to the application; one
 * that arrives with a valid exact target stays — exact onboarding remains accessible after setup.
 */
export function OnboardingBoundary({ agentId, review }: { agentId?: string; review?: "reboard" }) {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  /**
   * Whether the Account had already finished setup when it arrived. Finishing the flow from an
   * incomplete Account opens the normal gate and sends the reader into the application; an exact
   * setup link visited by a completed Account instead stays open, so reporting completion there
   * must not navigate away.
   */
  const arrivedCompleted = useRef(me.setupCompletedAt !== null);
  // Held stable: the flow retries this a bounded number of times, and an identity that changed on
  // every render would reopen that budget each time.
  const complete = useCallback(
    async (adoptedAgentId: string) => {
      await browserApi.completeSetup(adoptedAgentId);
      await refreshMe();
      forgetReboardReview();
      if (!arrivedCompleted.current) await navigate({ replace: true, to: "/agents" });
    },
    [navigate, refreshMe],
  );
  if (me.setupCompletedAt && agentId === undefined) return <Redirect replace to="/agents" />;
  return (
    <TargetedOnboarding
      agentId={agentId}
      onComplete={complete}
      review={review}
      reviewMode={review === "reboard" || isReboardReviewFor(me.user.id)}
    />
  );
}

function TargetedOnboarding({
  agentId,
  onComplete,
  review,
  reviewMode,
}: {
  agentId?: string;
  onComplete: (agentId: string) => Promise<void>;
  review?: "reboard";
  reviewMode: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [resolution, setResolution] = useState<TargetResolution>({ kind: "loading" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the explicit retry signal; bumping it must re-run the read even though the effect body never reads it.
  useEffect(() => {
    let live = true;
    setResolution({ kind: "loading" });
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
  }, [agentId, attempt]);

  if (resolution.kind === "loading") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas"
        data-ui="onboarding-target-loading"
      >
        <Loader />
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {m.onboarding_target_loading()}
        </p>
      </div>
    );
  }

  if (resolution.kind === "read-failed") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas p-6"
        data-ui="onboarding-target-read-failed"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_target_read_failed_title()}
        </Text>
        <p className="text-sm text-kumo-danger m-0 max-w-prose text-center" role="alert">
          {m.onboarding_target_read_failed_detail()}
        </p>
        <Button onClick={() => setAttempt((current) => current + 1)}>{m.onboarding_target_retry()}</Button>
      </div>
    );
  }

  if (resolution.kind === "unavailable") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-kumo-canvas p-6"
        data-ui="onboarding-target-unavailable"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_target_unavailable_title()}
        </Text>
        <p className="text-sm text-kumo-subtle m-0 max-w-prose text-center" role="alert">
          {m.onboarding_target_unavailable_detail()}
        </p>
      </div>
    );
  }

  if (resolution.kind === "redirect") {
    return <Redirect replace search={{ agentId: resolution.agentId, review }} to="/onboarding" />;
  }

  if (resolution.kind === "choice") {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-kumo-canvas p-6"
        data-ui="onboarding-target-choice"
      >
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_target_choice_title()}
        </Text>
        <p className="text-sm text-kumo-subtle m-0 max-w-prose text-center">{m.onboarding_target_choice_detail()}</p>
        <ul className="grid w-full max-w-md gap-2 m-0 list-none p-0">
          {resolution.agents.map((agent) => (
            <li key={agent.id}>
              <Link
                className="block rounded-lg bg-kumo-base px-4 py-3 text-sm text-kumo-strong ring ring-kumo-line"
                search={{ agentId: agent.id, review }}
                to="/onboarding"
              >
                {agent.displayName}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return <OnboardingV2Page onComplete={onComplete} reviewMode={reviewMode} />;
}
