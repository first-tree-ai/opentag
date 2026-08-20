import type { AgentSummary, Computer, MeMembership, MembershipRole } from "@opentag/shared/browser";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { browserApi } from "../api.js";
import { CreateTeamForm } from "../create-team-form.js";
import { FeishuSetupAttemptPanel, useFeishuSetup } from "../feishu-setup.js";
import { SELECTED_TEAM_STORAGE_KEY, type TeamSession, useTeamSession } from "../team-context.js";
import { AsyncState, DefinitionList, EmptyState, Page, useResource } from "../ui.js";
import {
  acknowledgeableComputer,
  canManageOnboarding,
  deriveAgentName,
  deriveOnboardingState,
  ONBOARDING_STEPS,
  type OnboardingComputer,
  type OnboardingFacts,
  type OnboardingState,
  type OnboardingStepId,
  selectOnboardingAgent,
} from "./flow.js";
import { createOrRecoverAgent } from "./recover-created-agent.js";

const STEP_TITLES: Record<OnboardingStepId, string> = {
  team: "Create or join a Team",
  computer: "Connect a Local Computer",
  provider: "Prepare the Codex CLI",
  agent: "Create your Agent",
  im: "Connect Feishu",
  ready: "Start working in Feishu",
};

const POLL_INTERVAL_MS = 1_500;

export function OnboardingPage() {
  const session = useTeamSession();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const membership = session.membership;
  const role = membership?.role ?? "member";
  const state = useResource(
    () => loadOnboardingFacts(membership, role),
    `${membership?.teamId ?? "no-team"}:${revision}`,
  );
  return (
    <Page title="Set up OpenTag" eyebrow={membership?.teamDisplayName}>
      <AsyncState state={state}>
        {(facts) => <OnboardingFlow facts={facts} onRefresh={refresh} session={session} />}
      </AsyncState>
    </Page>
  );
}

async function loadOnboardingFacts(
  membership: MeMembership | undefined,
  role: MembershipRole,
): Promise<OnboardingFacts> {
  if (!membership) {
    return { role, membership: undefined, computers: [], agents: [], binding: undefined, acknowledgedComputerIds: [] };
  }
  const [computers, agents] = await Promise.all([
    // Agent creation runs on a Computer the manager owns, but a member cannot see
    // those. Reading the Team-scoped list keeps the read-only view honest about
    // which step the Admin is actually on.
    canManageOnboarding(role)
      ? browserApi.ownComputers().then((value) => value.computers)
      : browserApi.computers(membership.teamId).then((value) => value.computers),
    browserApi.agents(membership.teamId),
  ]);
  const agent = selectOnboardingAgent(agents.agents);
  const binding = agent ? await browserApi.imBinding(agent.id) : undefined;
  return {
    role,
    membership,
    computers,
    agents: agents.agents,
    binding,
    acknowledgedComputerIds: readAcknowledgedComputerIds(computers),
  };
}

function OnboardingFlow({
  facts,
  onRefresh,
  session,
}: {
  facts: OnboardingFacts;
  onRefresh: () => void;
  session: TeamSession;
}) {
  const state = deriveOnboardingState(facts);
  return (
    <>
      <OnboardingProgress state={state} />
      {state.canManage ? (
        <ActiveStep facts={facts} onRefresh={onRefresh} session={session} state={state} />
      ) : (
        <EmptyState title="A Team Admin is setting OpenTag up">
          You will be able to work with this Team's Agents in Feishu once an Admin finishes {""}
          {STEP_TITLES[state.step].toLowerCase()}.
        </EmptyState>
      )}
    </>
  );
}

function OnboardingProgress({ state }: { state: OnboardingState }) {
  const completed = new Set<OnboardingStepId>(state.completed);
  return (
    <ol className="steps" aria-label="Setup progress">
      {ONBOARDING_STEPS.map((step) => {
        const status = completed.has(step) ? "done" : step === state.step ? "current" : "pending";
        return (
          <li aria-current={status === "current" ? "step" : undefined} data-status={status} key={step}>
            {STEP_TITLES[step]}
            {status === "done" ? <span className="muted"> · done</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ActiveStep({
  facts,
  onRefresh,
  session,
  state,
}: {
  facts: OnboardingFacts;
  onRefresh: () => void;
  session: TeamSession;
  state: OnboardingState;
}) {
  const membership = facts.membership;
  // Without a Team there is no Team-scoped step to render, and the derived step agrees.
  if (!membership || state.step === "team") return <TeamStep onCreated={session.refreshMe} />;
  if (state.step === "computer") return <ComputerStep onRefresh={onRefresh} teamId={membership.teamId} />;
  if (state.step === "provider") {
    const computer = acknowledgeableComputer(state.computer);
    if (computer) return <ProviderStep computer={computer} onRefresh={onRefresh} />;
  }
  if (!state.agent)
    return (
      <AgentStep
        managerUserId={session.me.user.id}
        onRefresh={onRefresh}
        selection={state.computer}
        teamId={membership.teamId}
      />
    );
  if (state.step === "im") return <ImStep agent={state.agent} onRefresh={onRefresh} state={state} />;
  return <ReadyStep agent={state.agent} />;
}

function StepPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * The same `CreateTeamForm` the standalone `/teams/new` page mounts. Creating a
 * Team behaves identically in both places; only what happens next differs, and
 * here that is advancing to the next unfinished step of this same flow.
 */
function TeamStep({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  return (
    <StepPanel title={STEP_TITLES.team}>
      <p>A Team holds your members, Agents and permissions. You become its first Team Admin.</p>
      <CreateTeamForm
        onCreated={(created) => {
          window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, created.id);
          onCreated();
        }}
        onUnauthenticated={() => navigate(`/login?next=${encodeURIComponent("/onboarding")}`)}
      />
    </StepPanel>
  );
}

function ComputerStep({ onRefresh, teamId }: { onRefresh: () => void; teamId: string }) {
  const [bootstrapCommand, setBootstrapCommand] = useState<string>();
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState(false);
  const baseline = useRef<Map<string, string>>(new Map());
  async function generate() {
    try {
      setError(undefined);
      const owned = await browserApi.ownComputers();
      baseline.current = new Map(owned.computers.map((computer: Computer) => [computer.id, computer.lastSeenAt]));
      setBootstrapCommand((await browserApi.issueConnectCode(teamId)).bootstrapCommand);
      setWaiting(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create a Computer connection command");
    }
  }
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void browserApi.ownComputers().then(
        (value) => {
          const connected = value.computers.some(
            (computer: Computer) => baseline.current.get(computer.id) !== computer.lastSeenAt,
          );
          if (!connected) return;
          setWaiting(false);
          onRefresh();
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to refresh Computers"),
      );
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, onRefresh]);
  return (
    <StepPanel title={STEP_TITLES.computer}>
      <p>Your Agent runs on a Computer you control. Generate a short-lived command and run it in a terminal there.</p>
      <button className="button" type="button" onClick={() => void generate()}>
        Generate connection command
      </button>
      {bootstrapCommand ? (
        <>
          <pre>
            <code>{bootstrapCommand}</code>
          </pre>
          <p role="status">{waiting ? "Waiting for the Computer to connect…" : "Computer connected."}</p>
        </>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
    </StepPanel>
  );
}

function ProviderStep({ computer, onRefresh }: { computer: OnboardingComputer; onRefresh: () => void }) {
  return (
    <StepPanel title={STEP_TITLES.provider}>
      <p>
        Your Agent runs Codex under your own identity on {computer.displayName}. Install the Codex CLI and sign in
        there, then confirm below.
      </p>
      <pre>
        <code>npm install -g @openai/codex{"\n"}codex login</code>
      </pre>
      <p className="muted">
        OpenTag cannot yet observe whether Codex is installed and signed in, so this step is your confirmation. It never
        blocks the Agent from being created — a missing sign-in surfaces as a failed Turn instead.
      </p>
      <button
        className="button"
        type="button"
        onClick={() => {
          acknowledgeComputer(computer.id);
          onRefresh();
        }}
      >
        Codex is ready on {computer.displayName}
      </button>
    </StepPanel>
  );
}

function AgentStep({
  managerUserId,
  onRefresh,
  selection,
  teamId,
}: {
  managerUserId: string;
  onRefresh: () => void;
  selection: OnboardingState["computer"];
  teamId: string;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const choices = selection.kind === "choice" ? selection.computers : [];
  const only = selection.kind === "single" ? selection.computer : undefined;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const displayName = String(data.get("displayName") ?? "").trim();
    const computerId = only?.id ?? String(data.get("computerId") ?? "");
    if (!displayName || !computerId) return;
    // With several Computers the confirmation is made here, against the machine the
    // Admin actually picked, so the Agent can never land on an unconfirmed one.
    if (!only) acknowledgeComputer(computerId);
    setBusy(true);
    try {
      setError(undefined);
      // Creation is retry-safe: a lost response is recovered by name instead of
      // creating a second Agent under the team/name unique index.
      await createOrRecoverAgent(
        {
          createAgent: (input) => browserApi.createAgent(teamId, input),
          listAgents: async () => (await browserApi.agents(teamId)).agents,
          agentConfig: (agentId) => browserApi.agentConfig(agentId),
        },
        // receiveMode is deliberately omitted so the Agent keeps the mention_only default.
        { name: deriveAgentName(displayName), displayName, runtimeProvider: "codex", computerId },
        managerUserId,
      );
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent creation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <StepPanel title={STEP_TITLES.agent}>
      <form className="form-card" onSubmit={submit}>
        <label>
          Agent name
          <input name="displayName" placeholder="Reviewer" required />
        </label>
        {only ? (
          <p className="muted">Runs Codex on {only.displayName}.</p>
        ) : (
          <>
            <label>
              Computer
              <select name="computerId" required>
                {choices.map((computer) => (
                  <option value={computer.id} key={computer.id}>
                    {computer.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input name="providerReady" required type="checkbox" />
              Codex is installed and signed in on that Computer
            </label>
          </>
        )}
        <p className="muted">This Agent replies only when it is mentioned.</p>
        <button className="button" disabled={busy} type="submit">
          Create Agent
        </button>
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </StepPanel>
  );
}

function ImStep({ agent, onRefresh, state }: { agent: AgentSummary; onRefresh: () => void; state: OnboardingState }) {
  const setup = useFeishuSetup(agent.id, onRefresh);
  const attention = state.im.kind === "attention" ? state.im : undefined;
  // The Server only accepts `reauthorize` for an existing Feishu binding, so a
  // degraded Slack binding is reported and handed to the Agent's IM tab instead.
  const recoverable = attention?.binding.provider === "feishu";
  return (
    <StepPanel title={STEP_TITLES.im}>
      <p>
        Authorize a Feishu bot for {agent.displayName}. Scan the code with the Feishu account that owns the workspace.
      </p>
      {attention ? (
        <div className="notice" role="status">
          The existing {attention.binding.provider} binding needs attention: {attention.reason.replaceAll("_", " ")}.{" "}
          {agent.displayName} is still ready for work that does not go through {attention.binding.provider}.
        </div>
      ) : null}
      {state.im.kind === "provisioning" ? <p role="status">Finishing the Feishu bot setup…</p> : null}
      {attention && !recoverable ? (
        <Link to={`/agents/${agent.id}/im`}>Review the IM binding for {agent.displayName}</Link>
      ) : null}
      {!setup.attempt && (!attention || recoverable) ? (
        <button className="button" type="button" onClick={() => void setup.start(attention ? "reauthorize" : "create")}>
          {attention ? "Reauthorize Feishu" : "Connect Feishu"}
        </button>
      ) : null}
      {setup.attempt ? (
        <FeishuSetupAttemptPanel attempt={setup.attempt} onRetry={(intent) => void setup.start(intent)} />
      ) : null}
      {setup.error ? (
        <div className="notice error" role="alert">
          {setup.error}
        </div>
      ) : null}
    </StepPanel>
  );
}

function ReadyStep({ agent }: { agent: AgentSummary }) {
  return (
    <StepPanel title={STEP_TITLES.ready}>
      <p role="status">
        <strong>{agent.displayName} is ready.</strong>
      </p>
      <DefinitionList
        rows={[
          ["Agent", agent.displayName],
          ["Computer", agent.computer.displayName],
          [
            "IM policy",
            agent.receiveMode === "mention_only" ? "Replies only when mentioned" : "Receives every message",
          ],
        ]}
      />
      {/*
       * No deep link out to the IM client: the Server serves both Feishu and Lark
       * tenants (`feishuDomainForTeamBrand`), and the brand lives on
       * ImBindingAdminDetail rather than the summary this page reads, so any
       * hardcoded host would be wrong for half the tenants.
       */}
      <p>
        Open your Feishu client, add {agent.displayName} to a group, and <strong>@ it</strong> with your first piece of
        work.
      </p>
      <div className="actions">
        <Link className="button" to={`/agents/${agent.id}/general`}>
          Manage {agent.displayName}
        </Link>
      </div>
    </StepPanel>
  );
}

/**
 * The provider confirmation is the one onboarding fact with no Server home, so it is
 * remembered in this browser -- keyed by Computer, because that is the resource it
 * describes. The same machine then serves every Team its owner belongs to, and a
 * machine that was never confirmed still asks. Every other step is re-derived from
 * the Server on each entry; losing this one only repeats a step that creates nothing.
 */
function providerAcknowledgementKey(computerId: string): string {
  return `opentag.onboarding.providerReady:${computerId}`;
}

function readAcknowledgedComputerIds(computers: readonly OnboardingComputer[]): string[] {
  return computers
    .map((computer) => computer.id)
    .filter((id) => window.localStorage.getItem(providerAcknowledgementKey(id)) === "true");
}

function acknowledgeComputer(computerId: string): void {
  window.localStorage.setItem(providerAcknowledgementKey(computerId), "true");
}
