import type { AgentAdminConfig } from "@opentag/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import { Icon, Loader, Text } from "../../../ui/design-system.js";
import { NotFoundPage } from "../../not-found.js";
import { AsyncState, toResourceState } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import { useAgentDetailView } from "../agent-queries.js";
import { agentDetailLink } from "../agent-routes.js";
import { AgentComputerSettings } from "./agent-computer-settings.js";
import { AgentManageSettings } from "./agent-manage-settings.js";
import { newerConfig, useLatestConfig } from "./config-snapshot.js";
import { GeneralConfigForm } from "./general-config-form.js";
import { AgentMessagingSettings } from "./messaging-settings.js";
import { AgentModelSettings } from "./model-settings.js";
import { AgentResourcesSettings } from "./resources-settings.js";
import type { AgentSettingsSection } from "./sections.js";
import { agentSettingsAnchorId, isAgentSettingsSection } from "./sections.js";

/**
 * Everything an Account owner administers about one Agent, on one screen.
 *
 * `section` is an anchor rather than a page: `/settings/computer` shows the same screen with the
 * Computer block focused. The Agent cards send their failure exits to those URLs, so they keep
 * resolving, and a reader who follows one still arrives with the rest of the Agent's state in view
 * instead of one summary line per click.
 */
export function AgentSettingsPage({ agentId, section }: { agentId: string; section?: string }) {
  const routeState = useRouterState({ select: (state) => state.location.state });
  const initialAgent = routeState.agent?.id === agentId ? routeState.agent : undefined;
  const queryClient = useQueryClient();
  // Failure exits land here, so the page has to observe recovery on its own; it is where an
  // operator waits while a Computer reconnects or a Provider finishes installing.
  const state = useAgentDetailView(agentId, { watched: true, initialAgent });
  const anchor = section !== undefined && isAgentSettingsSection(section) ? section : undefined;
  if (section !== undefined && anchor === undefined) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <div className="grid gap-4">
            <Link
              className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link"
              {...agentDetailLink(agent.id)}
            >
              <Icon name="arrow-left" />
              Back to {agent.displayName}
            </Link>
            <div className="min-w-0">
              <AgentSettingsContent
                agent={agent}
                anchor={anchor}
                onAgentChanged={(saved) => {
                  /*
                   * A write answers with the record it produced. Publishing that answer before the
                   * refetch is what keeps the other blocks on this screen from holding a revision
                   * the next save would be refused for -- they all edit one Agent, so the moment
                   * one of them moves it on, the rest have to be looking at where it moved to.
                   */
                  if (saved) {
                    queryClient.setQueryData<AgentAdminConfig>(queryKeys.agents.config(agentId), (current) =>
                      newerConfig(current, saved),
                    );
                  }
                  // A write can change the Agent and its config together, so both are dropped.
                  void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all(agentId) });
                }}
              />
            </div>
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentSettingsContent({
  agent,
  anchor,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  anchor: AgentSettingsSection | undefined;
  onAgentChanged: (saved?: AgentAdminConfig) => void;
}) {
  // The config is read once for the whole screen: Name, Model, Resources and the danger zone all
  // describe the same record, and asking per block would show them settling at different times.
  const configState = toResourceState(
    useQuery({ queryKey: queryKeys.agents.config(agent.id), queryFn: () => browserApi.agentConfig(agent.id) }),
    /*
     * A re-read that fails degrades to the reading already in hand rather than replacing the screen
     * with a banner. Six editors are mounted on this record, and one of them is usually holding a
     * draft, an open dialog or a half-finished confirmation -- unmounting all of that because a
     * background request did not arrive costs the reader work they cannot get back.
     *
     * Showing the last reading is safe rather than optimistic: every write carries the revision it
     * was read at, so a stale one is refused by the Server rather than silently applied, and that
     * refusal is the one failure this screen knows how to recover from.
     */
    (config) => config,
  );
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          Agent settings
        </Text>
      </header>
      <AsyncState loading={<AgentSettingsLoading />} state={configState}>
        {(config) => (
          <AgentSettingsBlocks agent={agent} anchor={anchor} config={config} onAgentChanged={onAgentChanged} />
        )}
      </AsyncState>
    </div>
  );
}

function AgentSettingsBlocks({
  agent,
  anchor,
  config,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  anchor: AgentSettingsSection | undefined;
  config: AgentAdminConfig;
  onAgentChanged: (saved?: AgentAdminConfig) => void;
}) {
  // One reading of the record for every editor, and one that only ever moves forward: a refetch
  // that lands out of order behind a save must not hand a block a revision the Server has left.
  const latest = useLatestConfig(config);
  return (
    <div className="grid gap-6">
      <AgentSettingsBlock anchor={anchor} section="identity">
        <GeneralConfigForm config={latest} onAgentChanged={onAgentChanged} />
      </AgentSettingsBlock>
      <AgentSettingsBlock anchor={anchor} section="messaging">
        <AgentMessagingSettings agent={agent} onAgentChanged={onAgentChanged} />
      </AgentSettingsBlock>
      <AgentSettingsBlock anchor={anchor} section="computer">
        <AgentComputerSettings agent={agent} onAgentChanged={onAgentChanged} />
      </AgentSettingsBlock>
      <AgentSettingsBlock anchor={anchor} section="execution">
        <AgentModelSettings agent={agent} config={latest} onAgentChanged={onAgentChanged} />
      </AgentSettingsBlock>
      <AgentSettingsBlock anchor={anchor} section="instructions">
        <AgentResourcesSettings agent={agent} config={latest} onAgentChanged={onAgentChanged} />
      </AgentSettingsBlock>
      <div className="mt-4 border-t border-kumo-line pt-6">
        <AgentSettingsBlock anchor={anchor} section="manage">
          <AgentManageSettings agent={agent} config={latest} onAgentChanged={onAgentChanged} />
        </AgentSettingsBlock>
      </div>
    </div>
  );
}

/**
 * One block, and the target of its own deep link.
 *
 * Focus rather than scroll: a deep link is followed by keyboard as often as by pointer, and the
 * browser brings a newly focused element into view on its own, so moving focus also does the
 * scrolling. What it lands on is the block's heading -- "Computer, heading level 2" is what a
 * reader arriving from a failure exit needs to hear, where the block's container announces nothing
 * and, being the size of the block, would keep the caret parked over everything inside it.
 *
 * The heading is found rather than passed in so the six blocks stay unaware of being anchored; each
 * one owns its heading and this owns where a deep link lands. That rests on one invariant: a block's
 * own heading is the first `h2` in its subtree. A panel a block opens inside itself -- the Computer's
 * reconnect, Messaging's connected channel -- is therefore an `h3`, both because it belongs to the
 * block rather than beside it and because a second `h2` above the real one would move the landing.
 */
function AgentSettingsBlock({
  anchor,
  children,
  section,
}: {
  anchor: AgentSettingsSection | undefined;
  children: ReactNode;
  section: AgentSettingsSection;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = anchor === section;
  useEffect(() => {
    if (!active) return;
    const heading = ref.current?.querySelector<HTMLElement>("h2");
    if (!heading) return;
    // Made focusable here rather than in each block: a lone `tabIndex={-1}` written beside a
    // heading reads as unmotivated and gets tidied away, taking the anchor's landing point with it.
    heading.tabIndex = -1;
    heading.focus();
  }, [active]);
  return (
    <div className="min-w-0" id={agentSettingsAnchorId(section)} ref={ref}>
      {children}
    </div>
  );
}

function AgentSettingsLoading() {
  return (
    <div aria-label="Loading Agent settings" className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
      <span aria-hidden="true">
        <Loader />
      </span>
      <span>Loading Agent settings…</span>
    </div>
  );
}
