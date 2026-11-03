import type { AgentSchedule, AgentScheduleListItem, AgentScheduleListResponse } from "@opentag/shared/browser";
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Dialog, Icon, StatusIndicator, Text } from "../../ui/design-system.js";
import { scheduleRuleText, shortScheduleTime } from "./schedule-rule.js";

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
      <Text as="h2" size="lg" variant="heading">
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
  const last = item.lastDispatch;
  const lastFailed = last ? last.outcome !== "accepted" : false;
  return (
    <li className="grid gap-1 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <Text as="h3" headingSize="body" variant="heading">
            <button
              aria-expanded={expanded}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline-2 focus-visible:outline-kumo-brand"
              onClick={() => onToggle(item.id)}
              type="button"
            >
              <Icon className="size-4 shrink-0 text-kumo-subtle" name={expanded ? "chevron-down" : "chevron-right"} />
              <span className="wrap-anywhere">{item.name}</span>
            </button>
          </Text>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <StatusIndicator
            label={scheduleStatus(item)}
            tone={item.enabled && item.nextTriggerAt ? "success" : "neutral"}
          />
          <Button disabled={pendingId === item.id} onClick={() => onChange(item)} size="compact" variant="secondary">
            {item.enabled ? m.agents_schedules_pause() : m.agents_schedules_resume()}
          </Button>
        </div>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-sm text-kumo-subtle">
        <span>{scheduleRuleText(item.schedule, item.timezone)}</span>
        {item.nextTriggerAt ? (
          <span>
            {m.agents_schedules_next_short()}{" "}
            <time dateTime={item.nextTriggerAt}>{shortScheduleTime(item.nextTriggerAt, item.timezone)}</time>
          </span>
        ) : null}
        {last ? (
          <span className={lastFailed ? "text-kumo-danger" : undefined}>
            {m.agents_schedules_last_short()}{" "}
            <time dateTime={last.scheduledFor}>{shortScheduleTime(last.scheduledFor, item.timezone)}</time>
            {lastFailed ? ` · ${handoffOutcome(last.outcome)}` : null}
          </span>
        ) : null}
      </p>
      {expanded ? (
        <div className="grid gap-3 pt-2 pl-6">
          <ScheduleRowDetails detail={detail} />
          <div>
            <Button
              disabled={pendingId === item.id}
              onClick={() => onDelete(item)}
              size="compact"
              variant="secondary-destructive"
            >
              {m.agents_schedules_delete()}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
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

function scheduleStatus(schedule: AgentScheduleListItem): string {
  if (!schedule.enabled) return m.agents_schedules_paused();
  if (schedule.nextTriggerAt === null) return m.agents_schedules_exhausted();
  return m.agents_schedules_enabled();
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
        <DetailRow label={m.agents_schedules_rule()} value={scheduleRuleText(schedule.schedule, schedule.timezone)} />
        <DetailRow label={m.agents_schedules_timezone()} value={schedule.timezone} />
        <DetailRow label={m.agents_schedules_target()} value={targetLabel} />
        <DetailRow
          label={m.agents_schedules_next()}
          value={schedule.nextTriggerAt ? shortScheduleTime(schedule.nextTriggerAt, schedule.timezone) : "—"}
        />
        <DetailRow label={m.agents_schedules_last_dispatch()} value={outcome} />
        {last ? (
          <>
            <DetailRow
              label={m.agents_schedules_scheduled_for()}
              value={shortScheduleTime(last.scheduledFor, schedule.timezone)}
            />
            {last.attemptedAt ? (
              <DetailRow
                label={m.agents_schedules_attempted_at()}
                value={shortScheduleTime(last.attemptedAt, schedule.timezone)}
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
