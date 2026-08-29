import type { AgentAdminConfig, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AgentCreationFacts, AgentCreationFlow } from "../../agent-creation/agent-creation-flow.js";
import { browserApi } from "../../api.js";
import { FeishuSetup } from "../../im/feishu-setup.js";
import { Button, Dialog, Text } from "../../ui/design-system.js";
import { Page } from "../layout/page.js";
import type { LoadState } from "../resource/use-resource.js";
import { AsyncState, useResource } from "../resource/use-resource.js";
import { useWorkspace } from "../session/session-context.js";

export function useOwnComputersResource(accountId: string, refreshVersion = 0) {
  return useResource(() => browserApi.computers(), `${accountId}:${refreshVersion}`, {
    onBackgroundError: markOwnComputersUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
}

export function NewAgentPage() {
  const { me } = useWorkspace();
  const navigate = useNavigate();
  const [computerRefreshVersion, setComputerRefreshVersion] = useState(0);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const computers = useOwnComputersResource(me.user.id, computerRefreshVersion);
  return (
    <Page
      title={created ? "Agent created" : "Create Agent"}
      description={
        created
          ? "Connect messaging now or continue from the Agent overview."
          : "Name the Agent and prepare where it runs."
      }
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={() => navigate(`/agents/${created.id}`)} />
      ) : (
        <AgentCreationContent
          computers={computers}
          accountId={me.user.id}
          onCreated={setCreated}
          onRefresh={() => setComputerRefreshVersion((current) => current + 1)}
        />
      )}
    </Page>
  );
}

export function NewAgentDialog({
  open,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusRef: { current: HTMLButtonElement | null };
}) {
  const { me } = useWorkspace();
  const navigate = useNavigate();
  const [computerRefreshVersion, setComputerRefreshVersion] = useState(0);
  const computers = useOwnComputersResource(me.user.id, computerRefreshVersion);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const finish = () => {
    if (created) navigate(`/agents/${created.id}`);
  };
  const close = () => {
    if (created) finish();
    else onClose();
  };

  return (
    <Dialog
      busy={submitting}
      className="w-[min(42rem,calc(100vw-2rem))]"
      closeLabel="Close new Agent dialog"
      returnFocusRef={returnFocusRef}
      open={open}
      title="New Agent"
      onClose={close}
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={finish} />
      ) : (
        <AgentCreationContent
          computers={computers}
          accountId={me.user.id}
          onCancel={onClose}
          onCreated={setCreated}
          onRefresh={() => setComputerRefreshVersion((current) => current + 1)}
          onSubmittingChange={setSubmitting}
        />
      )}
    </Dialog>
  );
}

export function AgentCreationContent({
  computers,
  onCancel,
  onCreated,
  onRefresh,
  onSubmittingChange,
  accountId,
}: {
  computers: LoadState<{ computers: WorkspaceComputerSummary[] }>;
  onCancel?: () => void;
  onCreated: (agent: AgentAdminConfig) => void;
  onRefresh: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
  accountId: string;
}) {
  const current = computers.kind === "ready" ? computers.value : undefined;
  const [retained, setRetained] = useState(current);
  const [computerRefreshFocusActive, setComputerRefreshFocusActive] = useState(false);
  const computerRefreshFocusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (computers.kind === "ready") setRetained(computers.value);
  }, [computers]);

  const refreshFocusTarget = onCancel ? (
    <span
      className="sr-only"
      ref={computerRefreshFocusRef}
      role={computerRefreshFocusActive ? "status" : undefined}
      tabIndex={-1}
    >
      {computerRefreshFocusActive
        ? computers.kind === "loading"
          ? "Refreshing Computers"
          : computers.kind === "error"
            ? "Computer refresh failed"
            : "Computer connection updated"
        : null}
    </span>
  ) : null;

  if (computers.kind === "error") {
    return (
      <>
        {refreshFocusTarget}
        <AsyncState state={computers}>{() => null}</AsyncState>
      </>
    );
  }
  const value = current ?? retained;
  if (!value) {
    return (
      <>
        {refreshFocusTarget}
        <AsyncState state={computers}>{() => null}</AsyncState>
      </>
    );
  }
  return (
    <>
      {refreshFocusTarget}
      <AgentCreationFlow
        facts={agentCreationFactsFromOwnComputers(value.computers)}
        refreshing={computers.kind === "loading"}
        accountId={accountId}
        onCancel={onCancel}
        onComputerRefreshFocus={() => {
          setComputerRefreshFocusActive(true);
          computerRefreshFocusRef.current?.focus();
        }}
        onCreated={onCreated}
        onRefresh={onRefresh}
        onSubmittingChange={onSubmittingChange}
      />
    </>
  );
}

export function NewAgentMessagingStep({ agent, onFinish }: { agent: AgentAdminConfig; onFinish: () => void }) {
  return (
    <FeishuSetup agentId={agent.id} onSuccess={onFinish}>
      {(setup) => (
        <section className="grid gap-4" aria-labelledby="agent-created-heading" data-ui="agent-create-complete">
          <div>
            <span className="text-xs font-medium uppercase text-kumo-subtle">Agent created</span>
            <Text as="h2" id="agent-created-heading" variant="heading">
              Connect messaging
            </Text>
            <Text as="p" variant="secondary">
              Connect a Feishu Bot so teammates can mention {agent.displayName}.
            </Text>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void setup.start()}>Connect Feishu</Button>
            <Button variant="secondary" onClick={onFinish}>
              Set up later
            </Button>
          </div>
          {setup.feedback}
        </section>
      )}
    </FeishuSetup>
  );
}

export function agentCreationFactsFromOwnComputers(computers: readonly WorkspaceComputerSummary[]): AgentCreationFacts {
  return {
    computers: computers.map((computer) => ({
      id: computer.computerId,
      displayName: computer.displayName,
      connectionStatus: computer.connectionStatus,
    })),
    providers: computers.flatMap((computer) =>
      (computer.providerReadiness ?? []).map((readiness) => ({
        computerId: computer.computerId,
        provider: readiness.provider,
        runtimeReady: readiness.status === "ready",
        status: readiness.status,
      })),
    ),
    runtimeEvidenceAvailable:
      computers.length === 0 || computers.some((computer) => computer.providerReadiness !== undefined),
  };
}

export function markOwnComputersUnconfirmed(value: { computers: WorkspaceComputerSummary[] }): {
  computers: WorkspaceComputerSummary[];
} {
  return {
    computers: value.computers.map(({ providerReadiness: _providerReadiness, ...computer }) => computer),
  };
}
