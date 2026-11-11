import type { AgentSetupAction, AgentSetupComponent, AgentSetupSnapshot } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { browserApi } from "../api.js";
import { AgentComputerChoice, type AgentComputerInventoryAdapter } from "../features/agents/agent-computer-choice.js";
import { platformLabel } from "../features/agents/agent-presentation.js";
import { agentCreateLink } from "../features/agents/agent-routes.js";
import {
  type ComputerConnectAdapter,
  createAgentTargetedComputerConnectAdapter,
} from "../features/computer-connect/computer-connect.js";
import { ComputerRecovery } from "../features/computer-connect/computer-recovery.js";
import * as m from "../paraglide/messages.js";
import { syncAgentQueries } from "../query/agent-sync.js";
import { queryKeys } from "../query/keys.js";
import { buttonClassName, Icon, StatusIndicator, type StatusTone, Text } from "../ui/design-system.js";
import { preparationSummaryRows } from "./preparation-readiness.js";
import { CheckLine } from "./readiness-list.js";

const SECTION_HEADER = "flex flex-col gap-1";
const HINT = "text-sm text-kumo-subtle m-0";

export interface AgentSetupComputerAdapter {
  readonly connect: ComputerConnectAdapter;
  readonly inventory: AgentComputerInventoryAdapter;
}

export function LocalPreparationSections({
  agentId,
  computerAdapter,
  computerRefreshAction,
  onChanged,
  showCompletedPreparation,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupComputerAdapter;
  readonly computerRefreshAction?: ReactNode;
  readonly onChanged: () => void;
  readonly showCompletedPreparation: boolean;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { stage } = snapshot;
  // A Cloud Agent has no machine to connect and no CLIs to prepare: its environment section states
  // the managed fact and, when the service cannot execute, the deployment's reason.
  if (snapshot.computer.kind === "cloud") {
    return stage === "needs-runtime" || showCompletedPreparation ? (
      <CloudEnvironmentSection snapshot={snapshot} />
    ) : null;
  }
  return (
    <>
      {stage === "needs-computer" ? (
        <ComputerSetupSection
          agentId={agentId}
          computerAdapter={computerAdapter}
          refreshAction={computerRefreshAction}
          onChanged={onChanged}
          snapshot={snapshot}
        />
      ) : null}
      {stage === "needs-runtime" || stage === "needs-provider-clis" || showCompletedPreparation ? (
        <PreparationSummarySection snapshot={snapshot} />
      ) : null}
    </>
  );
}

/**
 * The Cloud environment leg. It renders the canonical Cloud component only: `available` states the
 * managed fact that the environment starts with the first real task, and any other status names
 * the deployment's reason. Nothing here claims a running machine or a completed probe.
 */
function CloudEnvironmentSection({ snapshot }: { readonly snapshot: AgentSetupSnapshot }) {
  const component = snapshot.components.find(
    (candidate): candidate is Extract<AgentSetupComponent, { kind: "cloud" }> => candidate.kind === "cloud",
  );
  if (!component) return null;
  const available = component.status === "available";
  return (
    <section className="otv2-preparation flex flex-col" data-ui="agent-setup-cloud">
      <header className={SECTION_HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_cloud_title()}
        </Text>
        <p className={HINT}>{m.onboarding_v2_cloud_description()}</p>
      </header>
      <div className="otv2-preparation__checks">
        <ComputerSummary
          status={available ? m.onboarding_v2_cloud_status_ready() : m.onboarding_v2_cloud_status_unavailable()}
          title={component.displayName}
          tone={available ? "success" : "warning"}
        />
        {!available ? (
          <p className={HINT} data-ui="agent-setup-cloud-blocked-detail" role="alert">
            {cloudUnavailableDetail(component.status)}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The deployment reason a Cloud component carries, as one reader-facing sentence. */
function cloudUnavailableDetail(status: Extract<AgentSetupComponent, { kind: "cloud" }>["status"]): string {
  switch (status) {
    case "execution-unavailable":
      return m.onboarding_v2_cloud_reason_execution();
    case "model-unavailable":
      return m.onboarding_v2_cloud_reason_model();
    default:
      return m.onboarding_v2_cloud_reason_disabled();
  }
}

function ComputerSetupSection({
  agentId,
  computerAdapter,
  refreshAction,
  onChanged,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupComputerAdapter;
  readonly refreshAction?: ReactNode;
  readonly onChanged: () => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { computer } = snapshot;
  const queryClient = useQueryClient();
  const serverComputerConnectAdapter = useMemo(
    () => createAgentTargetedComputerConnectAdapter(agentId, browserApi, queryClient),
    [agentId, queryClient],
  );
  const computerConnectAdapter = computerAdapter?.connect ?? serverComputerConnectAdapter;
  /*
   * A bind or repair moves the Computer state a snapshot GET begun before it may still be
   * answering through the shared cache. Retire that in-flight read at the completion boundary, so
   * the controller's next read starts after the write — the same operation boundary the messaging
   * writes get from the adapter itself — then sync the shared caches as before. Lab adapters keep
   * their own transport and their own isolation, so none of this touches them.
   */
  const afterComputerCompletion = (computers: boolean) => {
    if (computerAdapter) {
      onChanged();
      return;
    }
    void (async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.agentSetup(agentId) });
      void syncAgentQueries(queryClient, agentId, { computers });
      onChanged();
    })();
  };
  const afterBind = () => afterComputerCompletion(false);
  const afterRepair = () => afterComputerCompletion(true);
  if (computer.kind === "not-bound") {
    return (
      <NotBoundComputerSection
        agentId={agentId}
        computerConnectAdapter={computerConnectAdapter}
        inventoryAdapter={computerAdapter?.inventory}
        onChanged={afterBind}
        snapshot={snapshot}
      />
    );
  }
  if (computer.kind === "requires-rebind") {
    return (
      <section className="otv2-computer-step flex flex-col" data-state={computer.kind} data-ui="agent-setup-computer">
        <ComputerStepHeader />
        <div className="otv2-computer-step__body">
          <ComputerSummary
            metadata={platformLabel(computer.platform)}
            status={m.onboarding_v2_connect_no_computer_status()}
            title={computer.displayName}
            tone="neutral"
          />
          <p className={HINT}>
            {m.onboarding_v2_setup_computer_rebind({
              computerName: computer.displayName,
              name: snapshot.agent.displayName,
            })}
          </p>
          <Link {...agentCreateLink()} className={buttonClassName({ variant: "primary" })}>
            {m.agents_new_agent()}
          </Link>
        </div>
      </section>
    );
  }
  if (computer.kind === "observation-failed") {
    return (
      <section className="otv2-computer-step flex flex-col" data-state={computer.kind} data-ui="agent-setup-computer">
        <ComputerStepHeader />
        <div className="otv2-computer-step__body">
          <ComputerSummary
            metadata={platformLabel(computer.platform)}
            status={m.onboarding_v2_connect_unconfirmed()}
            title={computer.displayName}
            tone="warning"
          />
          {refreshAction}
        </div>
      </section>
    );
  }
  if (computer.kind === "cloud") {
    // A Cloud Agent never reaches the needs-computer stage: there is no machine to bind or repair.
    return null;
  }
  return (
    <BoundComputerSection
      computer={computer}
      computerConnectAdapter={computerConnectAdapter}
      onChanged={afterRepair}
      snapshot={snapshot}
    />
  );
}

function ComputerStepHeader({ title }: { readonly title?: string }) {
  return (
    <header className="grid gap-1" data-ui="agent-setup-computer-header">
      <Text as="h1" size="lg" variant="heading">
        {title ?? m.onboarding_v2_connect_title()}
      </Text>
    </header>
  );
}

function ComputerSummary({
  metadata,
  status,
  title,
  tone,
}: {
  readonly metadata?: string;
  /** Omitted while a command window below owns the status. */
  readonly status?: string;
  readonly title: string;
  readonly tone: StatusTone;
}) {
  return (
    <div
      className="otv2-computer-summary grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2"
      data-ui="agent-setup-computer-summary"
    >
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint text-kumo-brand"
      >
        <Icon name="laptop" />
      </span>
      {/* At phone width the platform moves to its own line, so the computer name is not cut short. */}
      <span className="flex min-w-0 flex-col gap-x-1.5 overflow-hidden sm:flex-row sm:items-baseline">
        <strong className="wrap-anywhere text-sm font-medium text-kumo-strong sm:truncate" title={title}>
          {title}
        </strong>
        {metadata ? <span className="shrink-0 text-sm text-kumo-subtle">{metadata}</span> : null}
      </span>
      {status ? <StatusIndicator className="justify-self-end" label={status} tone={tone} /> : null}
    </div>
  );
}

function NotBoundComputerSection({
  agentId,
  computerConnectAdapter,
  inventoryAdapter,
  onChanged,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerConnectAdapter: ComputerConnectAdapter;
  readonly inventoryAdapter?: AgentComputerInventoryAdapter;
  readonly onChanged: () => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const canBind = snapshot.actions.some((action) => action.kind === "bind-computer");
  // The heading names the step and the choice or command window below reports status; a "no
  // computer / not connected" summary row on top would only repeat both.
  const renderChoice = (choice: ReactNode, multiple = false) => (
    <>
      <ComputerStepHeader title={multiple ? m.agents_computer_choice_existing_heading() : undefined} />
      <div className="otv2-computer-step__body">{choice}</div>
    </>
  );
  return (
    <section className="otv2-computer-step flex flex-col" data-state="not-bound" data-ui="agent-setup-computer">
      {canBind ? (
        <AgentComputerChoice
          adapter={computerConnectAdapter}
          agentId={agentId}
          connectAnotherInline
          inventoryAdapter={inventoryAdapter}
          onBound={onChanged}
        >
          {renderChoice}
        </AgentComputerChoice>
      ) : (
        renderChoice(null)
      )}
    </section>
  );
}

function BoundComputerSection({
  computer,
  computerConnectAdapter,
  onChanged,
  snapshot,
}: {
  readonly computer: Extract<AgentSetupSnapshot["computer"], { kind: "bound" }>;
  readonly computerConnectAdapter: ComputerConnectAdapter;
  readonly onChanged: () => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const repair = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "repair-computer" }> =>
      action.kind === "repair-computer" && action.computerId === computer.computerId,
  );
  const offline = computer.kind === "bound" && computer.connectionStatus === "offline";
  return (
    <section className="otv2-computer-step flex flex-col" data-state={computer.kind} data-ui="agent-setup-computer">
      <ComputerStepHeader />
      <div className="otv2-computer-step__body">
        <ComputerSummary
          metadata={platformLabel(computer.platform)}
          // While the repair command window is shown it owns the status.
          status={
            offline && repair
              ? undefined
              : offline
                ? m.onboarding_v2_connect_offline()
                : m.onboarding_v2_connect_online()
          }
          title={computer.displayName}
          tone={offline ? "warning" : "success"}
        />
        {offline && repair ? (
          <ComputerRecovery computer={computer} adapter={computerConnectAdapter} onConnected={onChanged} />
        ) : null}
      </div>
    </section>
  );
}

function PreparationSummarySection({ snapshot }: { readonly snapshot: AgentSetupSnapshot }) {
  const rows = useMemo(() => preparationSummaryRows(snapshot), [snapshot]);
  const { computer } = snapshot;
  if (computer.kind === "not-bound") return null;
  return (
    <section className="otv2-preparation flex flex-col" data-ui="agent-setup-preparation">
      <header className={SECTION_HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_prep_title()}
        </Text>
      </header>
      <div className="otv2-preparation__checks">
        <ComputerSummary
          metadata={platformLabel(computer.platform)}
          status={m.onboarding_v2_connect_online()}
          title={computer.displayName}
          tone="success"
        />
        <ol aria-label={m.onboarding_v2_prep_title()} className="otv2-readiness" data-ui="readiness-list">
          <CheckLine check={rows.runtime} component="runtime" position={1} />
          <CheckLine check={rows.messaging} component="messaging-support" position={2} />
        </ol>
      </div>
    </section>
  );
}
