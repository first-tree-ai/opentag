import type { CloudSessionSummary } from "@opentag/shared/browser";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { formatDateTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { liveResourceQueryOptions } from "../../../query/live.js";
import { Banner, Button, Dialog, Text } from "../../../ui/design-system.js";
import { isTerminalResourceError, usePersistedSettledError } from "../../resource/resource-state.js";
import { CloudProgressNotice } from "./cloud-progress-notice.js";

export function CloudWorkspaceRecovery({ agentId, initialOpen = false }: { agentId: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    setOpen(initialOpen);
  }, [initialOpen]);
  return (
    <div className="grid gap-3">
      <CloudProgressNotice agentId={agentId} />
      {open ? <WorkspaceRecoveryPanel key={agentId} agentId={agentId} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

type Feedback = { error: boolean; text: string };
type WorkspaceConfirmation = { target: CloudSessionSummary; discard: boolean };

async function requestWorkspaceRelease(target: CloudSessionSummary, discardUnsavedChanges: boolean): Promise<Feedback> {
  const current = await browserApi.cloudWorkspaceStatus(target.sandboxId);
  if (current.environmentGeneration !== target.environmentGeneration)
    return { error: true, text: m.cloud_recovery_changed() };
  if (current.lifecycle === "unallocated") return { error: false, text: m.cloud_recovery_released() };
  try {
    const result = await browserApi.releaseCloudWorkspace(target.sandboxId, {
      environmentGeneration: target.environmentGeneration,
      ...(discardUnsavedChanges ? { discardUnsavedChanges: true as const } : {}),
    });
    return {
      error: false,
      text: result.lifecycle === "unallocated" ? m.cloud_recovery_released() : m.cloud_recovery_pending(),
    };
  } catch {
    try {
      await browserApi.cloudWorkspaceStatus(target.sandboxId);
    } catch {
      return { error: true, text: m.cloud_recovery_status_unavailable() };
    }
    return { error: true, text: m.cloud_recovery_uncertain() };
  }
}

function WorkspaceRecoveryPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.agents.workspaceRecovery(agentId);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      browserApi.agentCloudOverview(agentId, { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...liveResourceQueryOptions,
  });
  const settledError = usePersistedSettledError(queryKey, query);
  const terminalError = settledError && isTerminalResourceError(settledError);
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [busy, setBusy] = useState(false);
  const active = useRef(false);

  async function release(target: CloudSessionSummary, discardUnsavedChanges = false) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setFeedback(undefined);
    try {
      setFeedback(await requestWorkspaceRelease(target, discardUnsavedChanges));
    } catch {
      setFeedback({ error: true, text: m.cloud_recovery_read_failed() });
    } finally {
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.progressNotice(agentId) }),
      ]);
      setConfirmation(undefined);
      setBusy(false);
      active.current = false;
    }
  }

  function save(target: CloudSessionSummary) {
    if (target.taskState !== "idle") {
      setConfirmation({ target, discard: false });
      return;
    }
    void release(target);
  }

  const rows = terminalError ? [] : (query.data?.pages.flatMap((page) => page.sessions) ?? []);
  const canAct = query.isSuccess && !query.isError && !settledError && !busy;
  return (
    <section aria-labelledby={headingId} className="grid gap-4 rounded-lg border border-kumo-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text as="h2" id={headingId} variant="heading">
          {m.cloud_recovery_title()}
        </Text>
        <div className="flex gap-2">
          <Button
            size="compact"
            variant="secondary"
            disabled={busy || query.isFetching}
            onClick={() => void query.refetch()}
          >
            {m.common_refresh()}
          </Button>
          <Button size="compact" variant="ghost" disabled={busy} onClick={onClose}>
            {m.common_close()}
          </Button>
        </div>
      </div>
      <p className="text-sm text-kumo-subtle">{m.cloud_recovery_description()}</p>
      <RecoveryStatus
        feedback={feedback}
        loading={query.isPending}
        failed={settledError !== null}
        empty={!terminalError && query.isSuccess && rows.length === 0}
      />
      <ul className="grid gap-3">
        {rows.map((row) => (
          <WorkspaceRow
            key={`${row.sandboxId}:${row.environmentGeneration}`}
            row={row}
            disabled={!canAct}
            onSave={() => save(row)}
            onDiscard={() => setConfirmation({ target: row, discard: true })}
          />
        ))}
      </ul>
      {query.hasNextPage && !terminalError ? (
        <Button
          className="w-fit"
          variant="secondary"
          disabled={busy || query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {m.cloud_recovery_more()}
        </Button>
      ) : null}
      {busy ? <p role="status">{m.cloud_recovery_saving()}</p> : null}
      {confirmation && !terminalError ? (
        <WorkspaceReleaseDialog
          confirmation={confirmation}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
          onConfirm={() => void release(confirmation.target, confirmation.discard)}
        />
      ) : null}
    </section>
  );
}

function RecoveryStatus({
  feedback,
  loading,
  failed,
  empty,
}: {
  feedback?: Feedback;
  loading: boolean;
  failed: boolean;
  empty: boolean;
}) {
  return (
    <>
      {feedback ? (
        <Banner
          role={feedback.error ? "alert" : "status"}
          variant={feedback.error ? "error" : "secondary"}
          description={feedback.text}
        />
      ) : null}
      {loading ? <p role="status">{m.cloud_recovery_loading()}</p> : null}
      {failed ? <Banner role="alert" variant="error" description={m.cloud_recovery_read_failed()} /> : null}
      {empty ? <p>{m.cloud_recovery_empty()}</p> : null}
    </>
  );
}

function sessionLabel(row: CloudSessionSummary): string {
  const kind = {
    channel: m.cloud_recovery_channel,
    thread: m.cloud_recovery_thread,
    internal: m.cloud_recovery_internal,
  }[row.kind]();
  return m.cloud_recovery_session({ kind, reference: row.sessionId.slice(0, 8) });
}

function workspaceStatus(row: CloudSessionSummary): string {
  if (row.lifecycle === "unallocated") return m.cloud_recovery_released();
  if (row.lastErrorCode === "workspace_save_failed") return m.cloud_recovery_not_saved();
  if (row.lifecycle === "releasing") return m.cloud_recovery_pending();
  return {
    idle: m.cloud_recovery_idle,
    queued: m.cloud_recovery_queued,
    running: m.cloud_recovery_running,
    unknown: m.cloud_recovery_unknown,
  }[row.taskState]();
}

function WorkspaceRow({
  row,
  disabled,
  onSave,
  onDiscard,
}: {
  row: CloudSessionSummary;
  disabled: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const pending = row.lifecycle === "releasing" && row.lastErrorCode === null;
  return (
    <li aria-label={sessionLabel(row)} className="grid gap-3 rounded-lg bg-kumo-recessed p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <p className="font-medium">{sessionLabel(row)}</p>
          <p className="text-sm text-kumo-subtle">
            {m.cloud_recovery_updated({ time: formatDateTime(row.updatedAt) })}
          </p>
        </div>
        <span className="text-sm">{workspaceStatus(row)}</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button size="compact" variant="secondary" disabled={disabled || !row.canRelease || pending} onClick={onSave}>
          {row.lastErrorCode === "workspace_save_failed" ? m.cloud_recovery_save_release() : m.cloud_recovery_save()}
        </Button>
        <Button size="compact" variant="danger" disabled={disabled || !row.canDiscard || pending} onClick={onDiscard}>
          {m.cloud_recovery_discard_release()}
        </Button>
      </div>
    </li>
  );
}

function WorkspaceReleaseDialog({
  confirmation,
  busy,
  onClose,
  onConfirm,
}: {
  confirmation: WorkspaceConfirmation;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      busy={busy}
      title={
        confirmation.discard
          ? m.cloud_recovery_discard_title({ session: sessionLabel(confirmation.target) })
          : m.cloud_recovery_save_title({ session: sessionLabel(confirmation.target) })
      }
      description={confirmation.discard ? m.cloud_recovery_discard_description() : m.cloud_recovery_save_description()}
      onClose={onClose}
      role="alertdialog"
    >
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {m.common_cancel()}
        </Button>
        <Button variant={confirmation.discard ? "danger" : "secondary"} disabled={busy} onClick={onConfirm}>
          {confirmation.discard ? m.cloud_recovery_discard_confirm() : m.cloud_recovery_save()}
        </Button>
      </div>
    </Dialog>
  );
}
