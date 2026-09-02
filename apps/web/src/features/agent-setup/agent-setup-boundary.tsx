import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
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
  slackOAuthError,
}: {
  action?: "create";
  agentId?: string;
  invalidSearch?: boolean;
  slackOAuthError?: string;
}) {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const openAgent = useCallback(
    async (targetAgentId: string) => {
      await navigate(agentDetailLink(targetAgentId));
    },
    [navigate],
  );
  const backToAgents = useCallback(async () => {
    await navigate({ to: "/agents" });
  }, [navigate]);
  /*
   * The Account is read again before the created Agent's URL is opened. Whether an Account has
   * entered the application is derived from the Agents it has, so a stale read would still say it
   * has none — and leaving setup would land on a list that sends the reader straight back.
   */
  const openExactTarget = useCallback(
    async (createdAgentId: string) => {
      await refreshMe();
      await navigate({ replace: true, search: { agentId: createdAgentId }, to: "/agents/setup" });
    },
    [navigate, refreshMe],
  );
  return (
    <TargetedAgentSetup
      accountCompleted={me.hasActiveAgent}
      action={action}
      agentId={agentId}
      onBackToAgents={backToAgents}
      invalidSearch={invalidSearch}
      onOpenAgent={openAgent}
      onTarget={openExactTarget}
      slackOAuthError={slackOAuthError}
    />
  );
}

function TargetedAgentSetup({
  accountCompleted,
  action,
  agentId,
  invalidSearch,
  onBackToAgents,
  onOpenAgent,
  onTarget,
  slackOAuthError,
}: {
  accountCompleted: boolean;
  action?: "create";
  agentId?: string;
  invalidSearch: boolean;
  onBackToAgents: () => Promise<void>;
  onOpenAgent: (agentId: string) => Promise<void>;
  onTarget: (agentId: string) => Promise<void>;
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
    return <Redirect replace search={{ agentId: resolution.agentId }} to="/agents/setup" />;
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
                search={{ agentId: agent.id }}
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
    /*
     * Setting up an Agent is not an Account gate. The exact Agent has been proved owned and active,
     * and whether this Account has entered the application is answered by the Agents it has — so
     * there is nothing to record here and nothing to wait for before the setup surface renders.
     */
    return (
      <AgentSetupSurface
        agentId={resolution.agentId}
        key={resolution.agentId}
        onOpenAgent={() => onOpenAgent(resolution.agentId)}
        slackOAuthError={slackOAuthError}
      />
    );
  }

  return (
    <AgentSetupSurface onBackToAgents={accountCompleted ? onBackToAgents : undefined} onAgentAvailable={onTarget} />
  );
}
