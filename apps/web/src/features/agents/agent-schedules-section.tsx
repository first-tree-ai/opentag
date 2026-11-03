import type { AgentSchedule, AgentScheduleListItem, AgentScheduleListResponse } from "@opentag/shared/browser";
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import {
  Banner,
  Button,
  Dialog,
  DropdownMenu,
  Icon,
  StatusIndicator,
  type StatusTone,
  Text,
} from "../../ui/design-system.js";
import { formatScheduleTime, formatScheduleTimeShort, scheduleRuleSummary } from "./agent-schedule-format.js";

export { formatScheduleTime } from "./agent-schedule-format.js";

/** Account management for schedules pinned to this Agent's existing IM conversations. */
export function AgentSchedulesSection({ agentId, scheduleId }: { agentId: string; scheduleId?: string }) {
  const queryClient = useQueryClient();
  const listKey = queryKeys.agents.schedules(agentId);
  const [expandedId, setExpandedId] = useState<string | undefined>(scheduleId);
  const [deleteTarget, setDeleteTarget] = useState<AgentScheduleListItem | undefined>();
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [mutationError, setMutationError] = useState<string | undefined>();

  useEffect(() => setExpandedId(scheduleId), [scheduleId]);

  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => browserApi.agentSchedules(agentId, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const detail = useQuery({
    queryKey: queryKeys.agents.schedule(agentId, expandedId ?? ""),
    queryFn: () => browserApi.agentSchedule(agentId, expandedId as string),
    enabled: expandedId !== undefined,
    staleTime: 30_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const deepLinkedItem =
    expandedId && detail.data && !loaded.some((item) => item.id === expandedId) ? detail.data : undefined;
  const rows = deepLinkedItem ? [deepLinkedItem, ...loaded] : loaded;

  async function changeSchedule(item: AgentScheduleListItem, operation: "pause" | "resume") {
    setMutationError(undefined);
    setPendingId(item.id);
    try {
      const updated =
        operation === "pause"
          ? await browserApi.pauseAgentSchedule(agentId, item.id, item.revision)
          : await browserApi.resumeAgentSchedule(agentId, item.id, item.revision);
      queryClient.setQueryData(queryKeys.agents.schedule(agentId, item.id), updated);
      queryClient.setQueryData<InfiniteData<AgentScheduleListResponse>>(listKey, (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.map((row) => (row.id === item.id ? summaryOf(updated) : row)),
              })),
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: listKey });
    } catch {
      setMutationError(m.agents_schedules_mutation_error());
      await queryClient.invalidateQueries({ queryKey: listKey });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.schedule(agentId, item.id) });
    } finally {
      setPendingId(undefined);
    }
  }

  async function deleteSchedule() {
    const item = deleteTarget;
    if (!item) return;
    setMutationError(undefined);
    setPendingId(item.id);
    try {
      await browserApi.deleteAgentSchedule(agentId, item.id, item.revision);
      queryClient.setQueryData<InfiniteData<AgentScheduleListResponse>>(listKey, (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.filter((row) => row.id !== item.id),
              })),
            }
          : current,
      );
      queryClient.removeQueries({ queryKey: queryKeys.agents.schedule(agentId, item.id) });
      if (expandedId === item.id) setExpandedId(undefined);
      setDeleteTarget(undefined);
      await queryClient.invalidateQueries({ queryKey: listKey });
    } catch {
      setDeleteTarget(undefined);
      setMutationError(m.agents_schedules_mutation_error());
      await queryClient.invalidateQueries({ queryKey: listKey });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.schedule(agentId, item.id) });
    } finally {
      setPendingId(undefined);
    }
  }

  return (
    <section
      className="grid gap-4 ui-surface bg-kumo-base p-6 max-[640px]:p-5 ring ring-kumo-line"
      aria-label={m.agents_schedules_title()}
    >
      <Text as="h2" variant="heading">
        {m.agents_schedules_title()}
      </Text>
      {mutationError ? <Banner variant="error">{mutationError}</Banner> : null}
      {list.isPending && !deepLinkedItem ? <p className="text-sm text-kumo-subtle">{m.common_loading()}</p> : null}
      {list.isError && loaded.length === 0 ? (
        <div className="grid justify-items-start gap-2">
          <p className="text-sm text-kumo-subtle">{m.agents_schedules_list_error()}</p>
          <Button onClick={() => void list.refetch()} size="compact" variant="secondary">
            {m.common_retry()}
          </Button>
        </div>
      ) : null}
      {expandedId &&
      !rows.some((item) => item.id === expandedId) &&
      detail.error instanceof ApiError &&
      detail.error.status === 404 ? (
        <p className="text-sm text-kumo-subtle">{m.agents_schedules_not_found()}</p>
      ) : null}
      {!list.isPending && !list.isError && rows.length === 0 && !expandedId ? (
        <p className="text-sm text-kumo-subtle">{m.agents_schedules_empty()}</p>
      ) : null}
      <ScheduleList
        rows={rows}
        expandedId={expandedId}
        detail={detail}
        pendingId={pendingId}
        onToggle={(id) => setExpandedId(expandedId === id ? undefined : id)}
        onChange={(item) => void changeSchedule(item, item.enabled ? "pause" : "resume")}
        onDelete={setDeleteTarget}
      />
      {list.hasNextPage ? (
        <Button
          disabled={list.isFetchingNextPage}
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
          size="compact"
          variant="secondary"
        >
          {m.agents_schedules_load_more()}
        </Button>
      ) : null}
      {deleteTarget ? (
        <ScheduleDeleteDialog
          item={deleteTarget}
          busy={pendingId === deleteTarget.id}
          onClose={() => setDeleteTarget(undefined)}
          onConfirm={() => void deleteSchedule()}
        />
      ) : null}
    </section>
  );
}

interface ScheduleListProps {
  rows: AgentScheduleListItem[];
  expandedId?: string;
  detail: { isPending: boolean; isError: boolean; error: Error | null; data?: AgentSchedule };
  pendingId?: string;
  onToggle: (id: string) => void;
  onChange: (item: AgentScheduleListItem) => void;
  onDelete: (item: AgentScheduleListItem) => void;
}

function ScheduleList(props: ScheduleListProps) {
  if (props.rows.length === 0) return null;
  return (
    <ul className="grid list-none divide-y divide-kumo-line">
      {props.rows.map((item) => (
        <ScheduleRow key={item.id} item={item} {...props} />
      ))}
    </ul>
  );
}

function ScheduleRow({
  item,
  expandedId,
  detail,
  pendingId,
  onToggle,
  onChange,
  onDelete,
}: ScheduleListProps & {
  item: AgentScheduleListItem;
}) {
  const expanded = expandedId === item.id;
  const status = scheduleStatus(item);
  return (
    <li className="grid gap-3 py-4 first:pt-0 last:pb-0" data-ui="agent-schedule-row">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="grid min-w-0 flex-1 basis-72 gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <Text as="h3" DANGEROUS_className="wrap-anywhere" headingSize="body" variant="heading">
              {item.name}
            </Text>
            <StatusIndicator label={status.label} tone={status.tone} />
          </div>
          <ScheduleMeta item={item} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* An enabled plan with no next occurrence has finished; pausing it would change nothing. */}
          {item.enabled && item.nextTriggerAt === null ? null : (
            <Button disabled={pendingId === item.id} onClick={() => onChange(item)} size="compact" variant="secondary">
              {item.enabled ? m.agents_schedules_pause() : m.agents_schedules_resume()}
            </Button>
          )}
          <Button aria-expanded={expanded} onClick={() => onToggle(item.id)} size="compact" variant="ghost">
            {m.agents_schedules_details()}
            <Icon name={expanded ? "chevron-up" : "chevron-down"} />
          </Button>
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  aria-label={m.agents_schedules_more_actions({ name: item.name })}
                  disabled={pendingId === item.id}
                  shape="square"
                  size="compact"
                  variant="ghost"
                />
              }
            >
              <Icon name="more-vertical" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item onClick={() => onDelete(item)} variant="danger">
                {m.agents_schedules_delete()}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </div>
      {expanded ? <ScheduleRowDetails detail={detail} /> : null}
    </li>
  );
}

/** One line: how often, when next, and the latest handoff when it needs attention. */
function ScheduleMeta({ item }: { item: AgentScheduleListItem }) {
  const last = item.lastDispatch;
  const once = item.schedule.kind === "at";
  return (
    <p className="flex flex-wrap items-center gap-y-1 text-sm text-kumo-subtle [&>*+*]:before:mx-2 [&>*+*]:before:content-['·']">
      <span>{scheduleRuleSummary(item.schedule, item.timezone)}</span>
      {item.enabled && item.nextTriggerAt && !once ? (
        <ScheduleTime
          instant={item.nextTriggerAt}
          timezone={item.timezone}
          render={(time) => m.agents_schedules_next_short({ time })}
        />
      ) : null}
      {last && !(once && last.outcome === "accepted") ? (
        <span>
          {once ? null : (
            <ScheduleTime
              instant={last.scheduledFor}
              timezone={item.timezone}
              render={(time) => m.agents_schedules_last_short({ time })}
            />
          )}
          {/* A received handoff is the normal case; only a failed or unconfirmed one is called out. */}
          {last.outcome === "accepted" ? null : (
            <span className="text-kumo-danger">
              {once ? "" : " "}
              {handoffOutcome(last.outcome)}
            </span>
          )}
        </span>
      ) : null}
    </p>
  );
}

/** A compact time with the full form on hover and in the machine-readable attribute. */
function ScheduleTime({
  instant,
  timezone,
  render,
}: {
  instant: string;
  timezone: string;
  render: (time: string) => string;
}) {
  return (
    <time dateTime={instant} title={formatScheduleTime(instant, timezone)}>
      {render(formatScheduleTimeShort(instant, timezone))}
    </time>
  );
}

function ScheduleRowDetails({ detail }: { detail: ScheduleListProps["detail"] }) {
  if (detail.isPending) return <p className="text-sm text-kumo-subtle">{m.common_loading()}</p>;
  if (detail.isError) {
    const message =
      detail.error instanceof ApiError && detail.error.status === 404
        ? m.agents_schedules_not_found()
        : m.agents_schedules_detail_error();
    return <p className="text-sm text-kumo-subtle">{message}</p>;
  }
  return detail.data ? <ScheduleDetail schedule={detail.data} /> : null;
}

function ScheduleDeleteDialog({
  item,
  busy,
  onClose,
  onConfirm,
}: {
  item: AgentScheduleListItem;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      busy={busy}
      description={m.agents_schedules_delete_confirm()}
      onClose={onClose}
      role="alertdialog"
      title={item.name}
    >
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose} variant="ghost">
          {m.common_cancel()}
        </Button>
        <Button disabled={busy} loading={busy} onClick={onConfirm} variant="danger">
          {m.agents_schedules_delete()}
        </Button>
      </div>
    </Dialog>
  );
}

function summaryOf(schedule: AgentSchedule): AgentScheduleListItem {
  const { prompt: _prompt, detailUrl: _detailUrl, ...summary } = schedule;
  return summary;
}

function scheduleStatus(schedule: AgentScheduleListItem): { label: string; tone: StatusTone } {
  if (!schedule.enabled) return { label: m.agents_schedules_paused(), tone: "neutral" };
  if (schedule.nextTriggerAt === null) return { label: m.agents_schedules_ended(), tone: "neutral" };
  return { label: m.agents_schedules_enabled(), tone: "success" };
}

function ScheduleDetail({ schedule }: { schedule: AgentSchedule }) {
  const last = schedule.lastDispatch;
  const target = schedule.target;
  const targetLabel =
    target.sessionKind === "thread" && target.threadKey
      ? m.agents_schedules_target_thread({
          provider: target.provider,
          channel: target.channelId,
          thread: target.threadKey,
        })
      : m.agents_schedules_target_channel({ provider: target.provider, channel: target.channelId });
  const outcome = last ? handoffOutcome(last.outcome) : m.agents_schedules_no_dispatch();
  return (
    <div className="grid gap-3 rounded-md bg-kumo-recessed p-4 text-sm">
      <dl className="grid gap-2">
        <DetailRow
          label={m.agents_schedules_rule()}
          value={scheduleRuleSummary(schedule.schedule, schedule.timezone)}
        />
        <DetailRow label={m.agents_schedules_timezone()} value={schedule.timezone} />
        <DetailRow label={m.agents_schedules_target()} value={targetLabel} />
        <DetailRow
          label={m.agents_schedules_next()}
          value={schedule.nextTriggerAt ? formatScheduleTime(schedule.nextTriggerAt, schedule.timezone) : "—"}
        />
        <DetailRow label={m.agents_schedules_last_dispatch()} value={outcome} />
        {last ? (
          <>
            <DetailRow
              label={m.agents_schedules_scheduled_for()}
              value={formatScheduleTime(last.scheduledFor, schedule.timezone)}
            />
            {last.attemptedAt ? (
              <DetailRow
                label={m.agents_schedules_attempted_at()}
                value={formatScheduleTime(last.attemptedAt, schedule.timezone)}
              />
            ) : null}
            {last.code ? <DetailRow label={m.agents_schedules_code()} value={last.code} /> : null}
          </>
        ) : null}
      </dl>
      {last ? (
        <div className="grid gap-2 text-kumo-subtle">
          <p>{handoffExplanation(last.outcome)}</p>
          {last.outcome !== "accepted" ? <p>{m.agents_schedules_no_retry()}</p> : null}
        </div>
      ) : null}
      <div className="grid gap-1">
        <strong className="text-kumo-strong">{m.agents_schedules_prompt()}</strong>
        <pre className="overflow-x-auto whitespace-pre-wrap wrap-anywhere font-sans text-kumo-default">
          {schedule.prompt}
        </pre>
      </div>
    </div>
  );
}

type HandoffOutcome = NonNullable<AgentScheduleListItem["lastDispatch"]>["outcome"];

function handoffOutcome(outcome: HandoffOutcome): string {
  return {
    accepted: m.agents_schedules_accepted,
    unreachable: m.agents_schedules_unreachable,
    rejected: m.agents_schedules_rejected,
    unknown: m.agents_schedules_unknown,
    skipped: m.agents_schedules_skipped,
  }[outcome]();
}

function handoffExplanation(outcome: HandoffOutcome): string {
  return {
    accepted: m.agents_schedules_accepted_explanation,
    unreachable: m.agents_schedules_unreachable_explanation,
    rejected: m.agents_schedules_rejected_explanation,
    unknown: m.agents_schedules_unknown_explanation,
    skipped: m.agents_schedules_skipped_explanation,
  }[outcome]();
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 @min-[35rem]/content:grid-cols-[10rem_1fr]">
      <dt className="text-kumo-subtle">{label}</dt>
      <dd className="wrap-anywhere text-kumo-default">{value}</dd>
    </div>
  );
}
