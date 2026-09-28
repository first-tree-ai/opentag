import type {
  AgentSchedule,
  AgentScheduleListItem,
  AgentScheduleListResponse,
  AgentScheduleRule,
} from "@opentag/shared/browser";
import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Banner, Button, Dialog, Text } from "../../ui/design-system.js";

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
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
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
  return (
    <li className="grid gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <strong className="wrap-anywhere text-sm text-kumo-strong">{item.name}</strong>
          <span className="text-sm text-kumo-subtle">{scheduleStatus(item)}</span>
          {item.nextTriggerAt ? (
            <span className="text-sm text-kumo-subtle">
              {m.agents_schedules_next()}: {formatScheduleTime(item.nextTriggerAt, item.timezone)}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button aria-expanded={expanded} onClick={() => onToggle(item.id)} size="compact" variant="secondary">
            {expanded ? m.agents_schedules_hide_details() : m.agents_schedules_show_details()}
          </Button>
          <Button disabled={pendingId === item.id} onClick={() => onChange(item)} size="compact" variant="secondary">
            {item.enabled ? m.agents_schedules_pause() : m.agents_schedules_resume()}
          </Button>
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
      {expanded ? <ScheduleRowDetails detail={detail} /> : null}
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

function scheduleRule(rule: AgentScheduleRule, timezone: string): string {
  if (rule.kind === "at") return m.agents_schedules_at({ time: formatScheduleTime(rule.at, timezone) });
  if (rule.kind === "every") return m.agents_schedules_every({ seconds: String(rule.intervalSeconds) });
  return m.agents_schedules_cron({ expression: rule.expression });
}

export function formatScheduleTime(instant: string, timezone: string): string {
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: timezone,
  }).format(new Date(instant));
  return `${formatted} (${timezone})`;
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
  const outcome = last
    ? {
        accepted: m.agents_schedules_accepted,
        unreachable: m.agents_schedules_unreachable,
        rejected: m.agents_schedules_rejected,
        unknown: m.agents_schedules_unknown,
        skipped: m.agents_schedules_skipped,
      }[last.outcome]()
    : m.agents_schedules_no_dispatch();
  return (
    <div className="grid gap-3 rounded-md bg-kumo-recessed p-4 text-sm">
      <dl className="grid gap-2">
        <DetailRow label={m.agents_schedules_rule()} value={scheduleRule(schedule.schedule, schedule.timezone)} />
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
      <div className="grid gap-1">
        <strong className="text-kumo-strong">{m.agents_schedules_prompt()}</strong>
        <pre className="overflow-x-auto whitespace-pre-wrap wrap-anywhere font-sans text-kumo-default">
          {schedule.prompt}
        </pre>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 @min-[35rem]/content:grid-cols-[10rem_1fr]">
      <dt className="text-kumo-subtle">{label}</dt>
      <dd className="wrap-anywhere text-kumo-default">{value}</dd>
    </div>
  );
}
