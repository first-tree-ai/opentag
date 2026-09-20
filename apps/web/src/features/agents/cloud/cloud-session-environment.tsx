import type {
  AccountSandboxRunnerStatusResponse,
  AccountSandboxRunnerStopRequest,
  AgentCloudOverview,
  CloudSessionSummary,
} from "@opentag/shared/browser";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type RefObject, useRef, useState } from "react";
import { ApiError, browserApi } from "../../../api.js";
import { formatDateTime, formatRelativeTime } from "../../../i18n/format.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { Banner, Button, Dialog, StatusIndicator, type StatusTone, Text } from "../../../ui/design-system.js";
import { agentTaskDetailLink } from "../agent-routes.js";

interface ReleaseOutcome {
  mode: "save" | "discard";
  status: AccountSandboxRunnerStatusResponse;
}

// Retain only the public environment fields. Task state and totals await a fresh overview.
function afterRelease(session: CloudSessionSummary, status: AccountSandboxRunnerStatusResponse): CloudSessionSummary {
  if (
    session.sandboxId !== status.sandboxId ||
    session.sessionId !== status.sessionId ||
    session.environmentGeneration > status.environmentGeneration
  )
    return session;
  return {
    ...session,
    lifecycle: status.lifecycle,
    environmentGeneration: status.environmentGeneration,
    runnerConnected: status.runnerConnected,
    runnerReady: status.runnerReady,
    lastErrorCode: status.lastErrorCode ? "environment_unavailable" : null,
    lastErrorAt: status.lastErrorAt,
    updatedAt: status.updatedAt,
    canRelease: false,
    canDiscard: false,
  };
}

function reconcileRelease(
  data: InfiniteData<AgentCloudOverview> | undefined,
  status: AccountSandboxRunnerStatusResponse,
) {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((session) => afterRelease(session, status)),
    })),
  };
}

/** The redacted codes the overview may carry; anything else is a generic "needs attention". */
function environmentErrorLabel(code: string): string {
  switch (code) {
    case "workspace_save_failed":
      return m.cloud_error_save_failed();
    case "workspace_restore_required":
      return m.cloud_error_restore_required();
    case "cloud_create_failed":
    case "cloud_create_rejected":
      return m.cloud_error_start_failed();
    case "cloud_create_uncertain":
    case "cloud_instance_unverified":
      return m.cloud_error_start_unconfirmed();
    case "cloud_delete_incomplete":
      return m.cloud_error_release_incomplete();
    default:
      return m.cloud_error_generic();
  }
}

function environmentErrorTone(code: string): StatusTone {
  switch (code) {
    case "workspace_save_failed":
    case "workspace_restore_required":
    case "cloud_create_failed":
    case "cloud_create_rejected":
      return "danger";
    default:
      return "warning";
  }
}

/**
 * The environment's own state, kept visibly separate from the Task running in it. Preparation is
 * stated generically — the overview carries no restore/upload breakdown, so nothing finer (and no
 * percentage or last-saved time) is claimed.
 */
export function cloudEnvironmentState(session: CloudSessionSummary): { label: string; tone: StatusTone } {
  if (session.lastErrorCode) {
    return {
      label: environmentErrorLabel(session.lastErrorCode),
      tone: environmentErrorTone(session.lastErrorCode),
    };
  }
  switch (session.lifecycle) {
    case "unallocated":
      return { label: m.cloud_environment_unallocated(), tone: "neutral" };
    case "preparing":
      return { label: m.cloud_environment_preparing(), tone: "info" };
    case "releasing":
      return { label: m.cloud_environment_releasing(), tone: "info" };
    case "ready":
      return readyEnvironmentState(session);
  }
}

function readyEnvironmentState(session: CloudSessionSummary): { label: string; tone: StatusTone } {
  if (session.runnerReady) return { label: m.cloud_environment_ready(), tone: "success" };
  if (session.runnerConnected) return { label: m.cloud_environment_runtime_starting(), tone: "info" };
  return { label: m.cloud_environment_runtime_waiting(), tone: "info" };
}

export function cloudTaskState(session: CloudSessionSummary): { label: string; tone: StatusTone } {
  switch (session.taskState) {
    case "queued":
      return { label: m.cloud_task_state_queued(), tone: "info" };
    case "running":
      return { label: m.cloud_task_state_running(), tone: "info" };
    case "unknown":
      return { label: m.cloud_task_state_unknown(), tone: "warning" };
    default:
      return { label: m.cloud_task_state_idle(), tone: "neutral" };
  }
}

function sessionKindLabel(kind: CloudSessionSummary["kind"]): string {
  if (kind === "channel") return m.cloud_session_kind_channel();
  if (kind === "thread") return m.cloud_session_kind_thread();
  return m.cloud_session_kind_internal();
}

function outcomeText(outcome: ReleaseOutcome): string {
  if (outcome.status.lifecycle !== "unallocated") return m.cloud_outcome_releasing();
  return outcome.mode === "discard" ? m.cloud_outcome_released_discarded() : m.cloud_outcome_released_saved();
}

function isReleaseRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 409;
}

function unconfirmedReleaseNotice(error: unknown): string {
  return error instanceof ApiError && error.status === 409 ? m.cloud_notice_conflict() : m.cloud_notice_unconfirmed();
}

/** Remount action state when the Account's selected Agent/Session environment changes. */
export function CloudSessionEnvironmentCard(props: {
  agentId: string;
  session: CloudSessionSummary;
  actionsEnabled?: boolean;
}) {
  return (
    <SessionEnvironment key={`${props.agentId}:${props.session.sessionId}:${props.session.sandboxId}`} {...props} />
  );
}

function SessionEnvironment({
  agentId,
  session,
  actionsEnabled = true,
}: {
  agentId: string;
  session: CloudSessionSummary;
  actionsEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState<"save" | "discard" | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<{ sandboxId: string; generation: number } | null>(null);
  const [outcome, setOutcome] = useState<ReleaseOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  // Unallocated is terminal for a generation. A confirmed release must not regress to an older read.
  const visibleOutcome = outcome?.status.environmentGeneration === session.environmentGeneration ? outcome : null;
  const displayedSession =
    visibleOutcome?.status.lifecycle === "unallocated" ? afterRelease(session, visibleOutcome.status) : session;

  async function runRelease(mode: "save" | "discard", generation: number) {
    if (pendingRef.current || !actionsEnabled) return;
    pendingRef.current = true;
    setPending(mode);
    setOutcome(null);
    setNotice(null);
    setActionError(null);
    const queryKey = queryKeys.agents.cloudOverview(agentId);
    const request: AccountSandboxRunnerStopRequest =
      mode === "discard" ? { discardUnsavedChanges: true, environmentGeneration: generation } : {};
    try {
      await queryClient.cancelQueries({ queryKey });
      const status = await browserApi.stopCloudSandbox(session.sandboxId, request);
      // Cancel reads started while stop was pending before writing the authoritative response.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueriesData<InfiniteData<AgentCloudOverview>>({ queryKey }, (data) =>
        reconcileRelease(data, status),
      );
      setDiscardConfirm(null);
      setOutcome({ mode, status });
    } catch (error) {
      if (isReleaseRefusal(error)) {
        setActionError(error.message);
      } else {
        setDiscardConfirm(null);
        setNotice(unconfirmedReleaseNotice(error));
      }
    } finally {
      // No mutation replay. Failed reads remain errors in the existing query cache.
      await queryClient.invalidateQueries({ queryKey });
      pendingRef.current = false;
      setPending(null);
    }
  }

  const discardStale =
    pending === null &&
    discardConfirm !== null &&
    (discardConfirm.sandboxId !== session.sandboxId ||
      discardConfirm.generation !== session.environmentGeneration ||
      !session.canDiscard ||
      !actionsEnabled);

  return (
    <div className="grid gap-3 py-4 first:pt-0 last:pb-0" data-kind={session.kind} data-ui="cloud-session-environment">
      <SessionRowHeader agentId={agentId} session={session} />
      <SessionStateFacts session={displayedSession} />
      {visibleOutcome ? <Banner description={outcomeText(visibleOutcome)} role="status" variant="secondary" /> : null}
      {notice ? <Banner description={notice} role="status" variant="alert" /> : null}
      {actionError && !discardConfirm ? <Banner description={actionError} role="alert" variant="error" /> : null}
      {visibleOutcome === null && actionsEnabled ? (
        <ReleaseActionButtons
          discardButtonRef={discardButtonRef}
          pending={pending}
          session={session}
          onDiscard={() =>
            setDiscardConfirm({ sandboxId: session.sandboxId, generation: session.environmentGeneration })
          }
          onSave={() => void runRelease("save", session.environmentGeneration)}
        />
      ) : null}
      {session.taskState !== "idle" && session.canRelease ? (
        <Text as="p" size="xs" variant="secondary">
          {m.cloud_release_stops_work()}
        </Text>
      ) : null}
      {discardConfirm ? (
        <DiscardReleaseDialog
          actionError={actionError}
          discardButtonRef={discardButtonRef}
          pending={pending}
          stale={discardStale}
          onClose={() => {
            setDiscardConfirm(null);
            setActionError(null);
          }}
          onConfirm={() => void runRelease("discard", discardConfirm.generation)}
        />
      ) : null}
    </div>
  );
}

function SessionRowHeader({ agentId, session }: { agentId: string; session: CloudSessionSummary }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="text-sm font-medium text-kumo-strong">{sessionKindLabel(session.kind)}</strong>
        {session.kind === "internal" ? null : (
          <Link className="text-sm text-kumo-link" {...agentTaskDetailLink(agentId, session.sessionId)}>
            {m.cloud_session_open_task()}
          </Link>
        )}
      </div>
      <time className="text-xs text-kumo-subtle" dateTime={session.updatedAt} title={formatDateTime(session.updatedAt)}>
        {m.cloud_session_updated({ relative: formatRelativeTime(session.updatedAt) })}
      </time>
    </div>
  );
}

/** Task and environment stay two facts: a completed Task can sit beside a failed workspace save. */
function SessionStateFacts({ session }: { session: CloudSessionSummary }) {
  const task = cloudTaskState(session);
  const environment = cloudEnvironmentState(session);
  return (
    <dl className="grid gap-x-8 gap-y-2 @min-[36rem]/content:grid-cols-2">
      <div className="grid min-w-0 gap-1">
        <Text as="dt" size="xs" variant="secondary">
          {m.cloud_task_state_label()}
        </Text>
        <dd className="min-w-0 text-sm">
          <StatusIndicator label={task.label} tone={task.tone} />
        </dd>
      </div>
      <div className="grid min-w-0 gap-1">
        <Text as="dt" size="xs" variant="secondary">
          {m.cloud_environment_label()}
        </Text>
        <dd className="min-w-0 text-sm">
          <StatusIndicator
            detail={
              session.lastErrorAt ? (
                <span className="text-xs opacity-80">{formatRelativeTime(session.lastErrorAt)}</span>
              ) : undefined
            }
            label={environment.label}
            tone={environment.tone}
          />
        </dd>
      </div>
    </dl>
  );
}

function ReleaseActionButtons({
  discardButtonRef,
  onDiscard,
  onSave,
  pending,
  session,
}: {
  discardButtonRef: RefObject<HTMLButtonElement | null>;
  onDiscard: () => void;
  onSave: () => void;
  pending: "save" | "discard" | null;
  session: CloudSessionSummary;
}) {
  if (!session.canRelease && !session.canDiscard) return null;
  return (
    <div className="flex flex-wrap gap-3">
      {session.canRelease ? (
        <Button
          disabled={pending !== null}
          loading={pending === "save"}
          type="button"
          variant="secondary"
          onClick={onSave}
        >
          {session.lastErrorCode === "workspace_save_failed"
            ? m.cloud_action_retry_save_release()
            : m.cloud_action_save_release()}
        </Button>
      ) : null}
      {session.canDiscard ? (
        <Button
          disabled={pending !== null}
          ref={discardButtonRef}
          type="button"
          variant="secondary-destructive"
          onClick={onDiscard}
        >
          {m.cloud_action_discard_release()}
        </Button>
      ) : null}
    </div>
  );
}

function DiscardReleaseDialog({
  actionError,
  discardButtonRef,
  onClose,
  onConfirm,
  pending,
  stale,
}: {
  actionError: string | null;
  discardButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: () => void;
  pending: "save" | "discard" | null;
  stale: boolean;
}) {
  return (
    <Dialog
      busy={pending !== null}
      description={m.cloud_discard_description()}
      returnFocusRef={discardButtonRef}
      role="alertdialog"
      title={m.cloud_discard_title()}
      onClose={onClose}
    >
      <div className="grid gap-4">
        {actionError ? <Banner description={actionError} role="alert" variant="error" /> : null}
        {stale ? <Banner description={m.cloud_discard_stale()} role="alert" variant="alert" /> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button disabled={pending !== null} type="button" variant="ghost" onClick={onClose}>
            {m.cloud_discard_keep()}
          </Button>
          {stale ? null : (
            <Button
              disabled={pending !== null}
              loading={pending === "discard"}
              type="button"
              variant="secondary-destructive"
              onClick={onConfirm}
            >
              {m.cloud_discard_confirm()}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
