import type { AgentCloudOverview } from "@opentag/shared/browser";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { ApiError } from "../../../api.js";
import { formatRelativeTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { Button, Icon, Loader, StatusIndicator, Text } from "../../../ui/design-system.js";
import { liveRefreshErrors, ResourceRefreshStatus, usePersistedSettledError } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import { AgentSettingsPageHeader } from "../agent-settings/settings-layout.js";
import { useAgentCloudOverview, useAgentComputerKind } from "./cloud-queries.js";
import { CloudSessionEnvironmentCard } from "./cloud-session-environment.js";

export { CloudSessionEnvironmentCard, cloudEnvironmentState, cloudTaskState } from "./cloud-session-environment.js";

type OverviewQuery = UseInfiniteQueryResult<InfiniteData<AgentCloudOverview>, Error>;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(m.cloud_overview_unavailable());
}

/** The read failed before anything was confirmed: say so and offer the retry, never a zeroed board. */
function CloudOverviewUnavailable({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="grid gap-3" data-ui="cloud-overview-unavailable" role="status">
      <Text as="p" variant="secondary">
        {m.cloud_overview_unavailable()}
      </Text>
      {error.message ? <p className="text-sm text-kumo-subtle">{error.message}</p> : null}
      <div>
        <Button size="compact" type="button" variant="secondary" onClick={onRetry}>
          {m.common_try_again()}
        </Button>
      </div>
    </div>
  );
}

function CloudOverviewLoading() {
  return (
    <div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
      <span aria-hidden="true">
        <Loader size="sm" />
      </span>
      <span>{m.cloud_overview_loading()}</span>
    </div>
  );
}

function CloudOverviewCounts({ overview }: { overview: AgentCloudOverview }) {
  const atCapacity = overview.capacity.accountUsed >= overview.capacity.accountLimit;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2" data-ui="cloud-overview-counts">
      <CloudCount label={m.cloud_count_agent_environments()} value={String(overview.counts.allocated)} />
      <CloudCount label={m.cloud_count_running()} value={String(overview.counts.running)} />
      <CloudCount label={m.cloud_count_queued()} value={String(overview.counts.queued)} />
      <CloudCount
        label={m.cloud_count_attention()}
        tone={overview.counts.attention > 0 ? "warning" : undefined}
        value={String(overview.counts.attention)}
      />
      <CloudCount
        label={m.cloud_count_environments()}
        tone={atCapacity ? "warning" : undefined}
        value={m.cloud_capacity_value({
          used: overview.capacity.accountUsed,
          limit: overview.capacity.accountLimit,
        })}
      />
    </dl>
  );
}

function CloudCount({ label, tone, value }: { label: string; tone?: "warning"; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="order-2 text-xs text-kumo-subtle">{label}</dt>
      <dd className={`order-1 text-sm font-semibold ${tone === "warning" ? "text-kumo-warning" : "text-kumo-strong"}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The Agent-wide Cloud board: counts that always describe the whole Agent, and the paginated
 * Session environments — IM and internal alike — beneath them. Counts come from the first page,
 * which every refetch reads again; later pages only add rows.
 */
export function AgentCloudOverviewPanel({ agentId }: { agentId: string }) {
  const overviewQuery = useAgentCloudOverview(agentId);
  const overviewError = overviewQuery.error ? asError(overviewQuery.error) : null;
  const persistedError = usePersistedSettledError(queryKeys.agents.cloudOverview(agentId), {
    error: overviewError,
    isError: overviewQuery.isError,
    isSuccess: overviewQuery.isSuccess,
  });
  const { terminalError, loadMoreError, refreshError } = liveRefreshErrors(
    { ...overviewQuery, error: overviewError },
    persistedError,
  );
  const unavailable = terminalError !== null || (overviewQuery.isError && !overviewQuery.data);
  const first = overviewQuery.data?.pages[0];
  return (
    <section
      aria-labelledby="agent-cloud-overview-heading"
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      data-ui="agent-cloud-overview"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Text as="h2" id="agent-cloud-overview-heading" variant="heading">
          {m.cloud_overview_title()}
        </Text>
        {first ? (
          <span className="text-xs text-kumo-subtle">
            {m.cloud_overview_observed({ relative: formatRelativeTime(first.observedAt) })}
          </span>
        ) : null}
      </div>
      {unavailable ? (
        <CloudOverviewUnavailable
          error={terminalError ?? overviewError ?? new Error(m.cloud_overview_unavailable())}
          onRetry={() => void overviewQuery.refetch()}
        />
      ) : overviewQuery.isPending ? (
        <CloudOverviewLoading />
      ) : first ? (
        <CloudOverviewBody
          agentId={agentId}
          first={first}
          loadMoreError={loadMoreError}
          overviewQuery={overviewQuery}
          refreshError={refreshError}
        />
      ) : null}
    </section>
  );
}

function CloudOverviewBody({
  agentId,
  first,
  loadMoreError,
  overviewQuery,
  refreshError,
}: {
  agentId: string;
  first: AgentCloudOverview;
  loadMoreError: Error | null;
  overviewQuery: OverviewQuery;
  refreshError: Error | null;
}) {
  const sessions = overviewQuery.data?.pages.flatMap((page) => page.sessions) ?? [];
  return (
    <>
      {refreshError ? (
        <ResourceRefreshStatus error={refreshError} onRetry={() => void overviewQuery.refetch()} />
      ) : null}
      <CloudOverviewCounts overview={first} />
      {sessions.length === 0 ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.cloud_overview_empty()}
        </p>
      ) : (
        <div className="grid divide-y divide-kumo-line" data-ui="cloud-session-environments">
          {sessions.map((session) => (
            <CloudSessionEnvironmentCard
              agentId={agentId}
              key={session.sessionId}
              session={session}
              actionsEnabled={overviewQuery.isSuccess && !overviewQuery.isFetching}
            />
          ))}
        </div>
      )}
      {overviewQuery.hasNextPage ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={overviewQuery.isFetching}
            loading={overviewQuery.isFetchingNextPage}
            type="button"
            variant="secondary"
            onClick={() => void overviewQuery.fetchNextPage({ cancelRefetch: false })}
          >
            {overviewQuery.isFetchingNextPage ? m.cloud_sessions_loading_more() : m.cloud_sessions_load_more()}
          </Button>
          {loadMoreError ? (
            <span className="text-sm text-kumo-subtle" role="status">
              {m.cloud_sessions_load_more_failed()}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * The Computer settings page for a Cloud Agent. The Cloud Computer is a logical identity that is
 * always online — it never reports offline and never offers the Local re-enrolment repair — so the
 * panel states what Cloud hosting means and hands the operative truth to the environment overview.
 */
export function CloudComputerSettings({ agent }: { agent: AgentDetailView }) {
  const computer = agent.computer;
  if (!computer) return null;
  return (
    <div className="grid gap-6">
      <AgentSettingsPageHeader
        description={m.cloud_computer_settings_description()}
        id="computer-heading"
        title={m.agents_status_computer()}
      />
      <section aria-labelledby="computer-device-heading" className="grid gap-3">
        <div className="grid gap-3">
          <header className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3" data-ui="computer-identity">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
              <Icon name="laptop" />
            </span>
            <div className="grid min-w-0 gap-1">
              <div className="grid min-w-0 gap-0.5 @min-[32rem]/content:flex @min-[32rem]/content:items-baseline @min-[32rem]/content:gap-x-1.5">
                <div className="min-w-0 break-words @min-[32rem]/content:truncate">
                  <Text as="h2" id="computer-device-heading" variant="heading">
                    {computer.displayName}
                  </Text>
                </div>
                <span aria-hidden="true" className="hidden text-sm text-kumo-subtle @min-[32rem]/content:inline">
                  ·
                </span>
                <span className="text-sm text-kumo-subtle">{m.cloud_computer_kind()}</span>
              </div>
              <StatusIndicator
                detail={m.cloud_computer_online_detail()}
                label={m.cloud_computer_online()}
                tone="success"
              />
            </div>
          </header>
          <p className="text-sm text-kumo-subtle">{m.cloud_computer_explanation()}</p>
        </div>
      </section>
      <AgentCloudOverviewPanel agentId={agent.id} />
    </div>
  );
}

/**
 * The Cloud environment of the Session one Task page is reading, beside the Task state the page
 * already shows. The section belongs only to a confirmed Cloud Agent: a Local Agent, or evidence
 * that has not settled, renders nothing rather than a guess.
 */
export function TaskCloudEnvironment({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const kind = useAgentComputerKind(agentId);
  const enabled = kind === "cloud";
  const overviewQuery = useAgentCloudOverview(agentId, { sessionId, enabled });
  const overviewError = overviewQuery.error ? asError(overviewQuery.error) : null;
  const persistedError = usePersistedSettledError(queryKeys.agents.cloudOverviewSession(agentId, sessionId), {
    error: overviewError,
    isError: overviewQuery.isError,
    isSuccess: overviewQuery.isSuccess,
  });
  if (!enabled) return null;
  return (
    <section
      aria-labelledby="task-cloud-environment-heading"
      className="grid gap-3 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      data-ui="task-cloud-environment"
    >
      <Text as="h2" id="task-cloud-environment-heading" variant="heading">
        {m.cloud_task_environment_title()}
      </Text>
      <TaskCloudEnvironmentBody
        agentId={agentId}
        overviewError={overviewError}
        overviewQuery={overviewQuery}
        persistedError={persistedError}
        sessionId={sessionId}
      />
    </section>
  );
}

function TaskCloudEnvironmentBody({
  agentId,
  overviewError,
  overviewQuery,
  persistedError,
  sessionId,
}: {
  agentId: string;
  overviewError: Error | null;
  overviewQuery: OverviewQuery;
  persistedError: Error | null;
  sessionId: string;
}) {
  const terminalError = persistedError && isTerminalOverviewError(persistedError) ? persistedError : null;
  if (terminalError || (overviewQuery.isError && !overviewQuery.data)) {
    return (
      <CloudOverviewUnavailable
        error={terminalError ?? overviewError ?? new Error(m.cloud_overview_unavailable())}
        onRetry={() => void overviewQuery.refetch()}
      />
    );
  }
  if (overviewQuery.isPending) return <CloudOverviewLoading />;
  const session = overviewQuery.data?.pages[0]?.sessions.find((entry) => entry.sessionId === sessionId);
  const refreshError = overviewQuery.data !== undefined && overviewQuery.isError ? overviewError : null;
  return (
    <>
      {refreshError ? (
        <ResourceRefreshStatus error={refreshError} onRetry={() => void overviewQuery.refetch()} />
      ) : null}
      {session ? (
        <CloudSessionEnvironmentCard
          agentId={agentId}
          key={session.sessionId}
          session={session}
          actionsEnabled={overviewQuery.isSuccess && !overviewQuery.isFetching}
        />
      ) : (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.cloud_task_environment_none()}
        </p>
      )}
    </>
  );
}

function isTerminalOverviewError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}
