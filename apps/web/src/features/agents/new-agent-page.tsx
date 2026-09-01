import type { AgentAdminConfig, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type AgentCreationFacts, AgentCreationFlow } from "../../agent-creation/agent-creation-flow.js";
import { FeishuSetup } from "../../im/feishu-setup.js";
import { messagingProviderLabelInSentence } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Button, Dialog, Text } from "../../ui/design-system.js";
import { Page } from "../layout/page.js";
import type { LoadState } from "../resource/resource-state.js";
import { AsyncState, toResourceState } from "../resource/resource-state.js";
import { useAccount } from "../session/session-context.js";
import { useComputersQuery } from "./agent-queries.js";
import { agentDetailLink } from "./agent-routes.js";

/**
 * The Account's Computers, plus the refresh the creation flow drives when a Computer it is waiting
 * for connects.
 *
 * The refresh reports loading, while the interval and focus re-reads behind it do not. The flow
 * depends on that distinction: it restores focus and announces the outcome by watching a refresh
 * begin and end, and a background re-read is not something the Account asked for and should not be
 * narrated. The page keeps showing the Computers it already has either way.
 *
 * The same distinction decides what a failure means. Degrading to the Computers already in hand is
 * right for revalidation nobody asked for, but the Account that pressed the button asked a
 * question, and answering a failed check with `Computer connection updated` reports the opposite of
 * what happened. So an explicit refresh keeps its own error until a read succeeds.
 */
export function useOwnComputersResource(): {
  state: LoadState<{ computers: WorkspaceComputerSummary[] }>;
  refresh: () => void;
} {
  const queryClient = useQueryClient();
  const query = useComputersQuery(true);
  const [refresh, setRefresh] = useState<{ pending: boolean; error?: Error }>({ pending: false });
  // The re-read starts from an effect rather than from the caller, so the render that reports
  // loading is committed before it can finish. Starting it inline would let a fast response land in
  // the same batch, leaving the flow no transition to notice.
  useEffect(() => {
    if (!refresh.pending) return;
    let watching = true;
    void queryClient.invalidateQueries({ queryKey: queryKeys.computers() }).finally(() => {
      if (!watching) return;
      // Invalidating resolves whether or not the re-read succeeded, so the outcome is read off the
      // query rather than off this promise.
      const settled = queryClient.getQueryState<{ computers: WorkspaceComputerSummary[] }, Error>(
        queryKeys.computers(),
      );
      setRefresh({ pending: false, error: settled?.status === "error" ? (settled.error ?? undefined) : undefined });
    });
    return () => {
      watching = false;
    };
  }, [refresh.pending, queryClient]);
  const state = toResourceState(query, markOwnComputersUnconfirmed);
  // A later success is what retires it: the Computers became readable again, so the failed check is
  // no longer what the Account is looking at.
  const refreshError = query.isSuccess ? undefined : refresh.error;
  return {
    state: refresh.pending ? { kind: "loading" } : refreshError ? { kind: "error", error: refreshError } : state,
    refresh: () => setRefresh({ pending: true }),
  };
}

export function NewAgentPage() {
  const { me } = useAccount();
  const navigate = useNavigate();
  const [created, setCreated] = useState<AgentAdminConfig>();
  const { state: computers, refresh: refreshComputers } = useOwnComputersResource();
  return (
    <Page
      title={created ? m.agents_created_title() : m.agents_create_title()}
      description={created ? m.agents_created_description() : m.agents_create_description()}
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={() => void navigate(agentDetailLink(created.id))} />
      ) : (
        <AgentCreationContent
          computers={computers}
          accountId={me.user.id}
          onCreated={setCreated}
          onRefresh={refreshComputers}
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
  const { me } = useAccount();
  const navigate = useNavigate();
  const { state: computers, refresh: refreshComputers } = useOwnComputersResource();
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const finish = () => {
    if (created) void navigate(agentDetailLink(created.id));
  };
  const close = () => {
    if (created) finish();
    else onClose();
  };

  return (
    <Dialog
      busy={submitting}
      className="w-[min(42rem,calc(100vw-2rem))]"
      closeLabel={m.agents_close_new_agent_dialog()}
      returnFocusRef={returnFocusRef}
      open={open}
      title={m.agents_new_agent()}
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
          onRefresh={refreshComputers}
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
          ? m.agents_refreshing_computers()
          : computers.kind === "error"
            ? m.agents_computer_refresh_failed()
            : m.agents_computer_connection_updated()
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
            <span className="text-xs font-medium uppercase text-kumo-subtle">{m.agents_created_title()}</span>
            <Text as="h2" id="agent-created-heading" variant="heading">
              {m.agents_connect_messaging()}
            </Text>
            <Text as="p" variant="secondary">
              {m.agents_connect_messaging_description({
                provider: messagingProviderLabelInSentence("feishu"),
                name: agent.displayName,
              })}
            </Text>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void setup.start()}>
              {m.agents_connect_feishu({ provider: messagingProviderLabelInSentence("feishu") })}
            </Button>
            <Button variant="secondary" onClick={onFinish}>
              {m.agents_set_up_later()}
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
