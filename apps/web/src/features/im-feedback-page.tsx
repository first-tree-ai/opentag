import type { ImFeedbackActionKind, ImFeedbackView } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { m } from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { Button, Checkbox, Collapsible, Text } from "../ui/design-system.js";
import { agentDetailLink, agentTaskDetailLink } from "./agents/agent-routes.js";

type FeedbackApi = Pick<typeof browserApi, "imFeedback" | "imFeedbackAction">;
type Selection = { kind: ImFeedbackActionKind; revision: number; generation: number | null };
function actionLabel(kind: ImFeedbackActionKind): string {
  if (kind === "retry_task") return m.im_feedback_retry();
  return kind === "save_release" ? m.im_feedback_save() : m.im_feedback_discard();
}
function actionWarning(kind: ImFeedbackActionKind): string {
  if (kind === "retry_task") return m.im_feedback_retry_warning();
  return kind === "save_release" ? m.im_feedback_save_warning() : m.im_feedback_discard_warning();
}
function resultText(action: NonNullable<ImFeedbackView["action"]>): string {
  if (["confirmed", "submitting", "checking"].includes(action.state)) return m.im_feedback_checking();
  if (action.state === "stale") return m.im_feedback_stale();
  if (action.state === "failed") return m.im_feedback_failed();
  if (action.resultCode === "released_unverified") return m.im_feedback_released_unverified();
  return action.kind === "retry_task"
    ? m.im_feedback_queued()
    : action.kind === "save_release"
      ? m.im_feedback_saved()
      : m.im_feedback_discarded();
}
function useFeedbackReview(
  feedbackId: string,
  api: FeedbackApi,
  refresh: () => Promise<{ data?: ImFeedbackView; isError: boolean }>,
) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const select = (kind: ImFeedbackActionKind, view: ImFeedbackView) => {
    setSelection({ kind, revision: view.revision, generation: view.environmentGeneration });
    setAcknowledged(false);
    setNotice(null);
  };
  const confirm = async () => {
    if (!selection || submitting) return;
    if (selection.kind === "discard" && !acknowledged) return;
    setSubmitting(true);
    try {
      const fresh = await refresh();
      const action = fresh.data?.actions.find((a) => a.kind === selection.kind);
      if (fresh.isError || !sameReview(selection, fresh.data) || !action) {
        setNotice(m.im_feedback_stale());
        setSelection(null);
        return;
      }
      try {
        await api.imFeedbackAction(feedbackId, {
          ...(selection.kind === "discard"
            ? ({ kind: "discard", permanentLossAcknowledged: true } as const)
            : { kind: selection.kind }),
          revision: selection.revision,
          confirmation: action.confirmation,
        });
        setNotice(null);
      } catch {
        setNotice(m.im_feedback_checking());
      }
      setSelection(null);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };
  return {
    selection,
    select,
    cancel: () => setSelection(null),
    acknowledged,
    setAcknowledged,
    submitting,
    notice,
    confirm,
  };
}
function sameReview(selection: Selection, view?: ImFeedbackView): boolean {
  return !!view && selection.revision === view.revision && selection.generation === view.environmentGeneration;
}
type Review = ReturnType<typeof useFeedbackReview>;
function FeedbackFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <PageHeader title={m.im_feedback_title()} />
      {children}
    </div>
  );
}
function FeedbackSummary({ view }: { view: ImFeedbackView }) {
  return (
    <>
      <p>{view.effects === "not_started" ? m.im_feedback_not_started() : m.im_feedback_effects_unknown()}</p>
      {view.state === "workspace_blocked" ? (
        <>
          <p>{m.im_feedback_workspace_paused()}</p>
          <p>{m.im_feedback_save_boundary()}</p>
        </>
      ) : null}
      {view.environmentGeneration !== null ? (
        <p className="font-medium">
          {m.im_feedback_workspace_version({ generation: String(view.environmentGeneration) })}
        </p>
      ) : null}
      {view.state !== "workspace_blocked" && view.retryBlockedReason === "batch_initial" ? (
        <p>{m.im_feedback_batch_retry_blocked()}</p>
      ) : null}
      {view.deliveryState === "send_unknown" ? <p role="status">{m.im_feedback_card_unknown()}</p> : null}
      {view.deliveryState === "blocked" ? <p role="alert">{m.im_feedback_card_blocked()}</p> : null}
      {view.action ? (
        <>
          <p role="status">{resultText(view.action)}</p>
          <p className="text-sm">
            {m.im_feedback_attribution({ actor: view.action.actorDisplayName, time: view.action.updatedAt })}
          </p>
        </>
      ) : null}
    </>
  );
}
function Confirmation({ review }: { review: Review }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const selection = review.selection;
  if (!selection) return null;
  const discard = selection.kind === "discard";
  return (
    <section aria-labelledby="feedback-confirm" className="space-y-4 rounded-lg border border-kumo-line p-4">
      <Text as="h2" id="feedback-confirm" variant="heading">
        {m.im_feedback_confirm_title()}
      </Text>
      <p className="font-medium">{actionLabel(selection.kind)}</p>
      <p>{actionWarning(selection.kind)}</p>
      {discard ? (
        <Checkbox
          checked={review.acknowledged}
          onCheckedChange={(checked) => review.setAcknowledged(checked === true)}
          disabled={review.submitting}
          label={m.im_feedback_discard_ack()}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          variant={discard ? "danger" : "primary"}
          onClick={() => void review.confirm()}
          disabled={review.submitting || (discard && !review.acknowledged)}
        >
          {m.im_feedback_confirm()}
        </Button>
        <Button ref={cancelRef} variant="secondary" onClick={review.cancel} disabled={review.submitting}>
          {m.im_feedback_cancel()}
        </Button>
      </div>
    </section>
  );
}
function FeedbackControls({
  view,
  operation,
  review,
}: {
  view: ImFeedbackView;
  operation?: ImFeedbackActionKind;
  review: Review;
}) {
  if (review.selection) return <Confirmation review={review} />;
  if (!view.actions.length) return view.action ? null : <p>{m.im_feedback_no_actions()}</p>;
  const actions = [...view.actions].sort((a, b) => (a.kind === operation ? -1 : b.kind === operation ? 1 : 0));
  return (
    <div className="flex flex-wrap gap-3">
      {actions.map((action) => (
        <Button
          key={action.kind}
          variant={action.kind === "discard" ? "danger" : "secondary"}
          onClick={() => review.select(action.kind, view)}
          disabled={review.submitting}
        >
          {actionLabel(action.kind)}
        </Button>
      ))}
    </div>
  );
}
export function ImFeedbackPage({
  feedbackId,
  operation,
  api = browserApi,
}: {
  feedbackId: string;
  operation?: ImFeedbackActionKind;
  api?: FeedbackApi;
}) {
  const query = useQuery({
    queryKey: queryKeys.imFeedback(feedbackId),
    queryFn: () => api.imFeedback(feedbackId),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.action && ["confirmed", "submitting", "checking"].includes(q.state.data.action.state)
        ? 5_000
        : false,
  });
  const review = useFeedbackReview(feedbackId, api, () => query.refetch());
  if (query.isPending)
    return (
      <FeedbackFrame>
        <p role="status">{m.im_feedback_loading()}</p>
      </FeedbackFrame>
    );
  const view = query.data;
  if (!view)
    return (
      <FeedbackFrame>
        <p role="alert">{m.im_feedback_unavailable()}</p>
      </FeedbackFrame>
    );
  return (
    <FeedbackFrame>
      <section aria-label={m.im_feedback_title()} className="space-y-4 rounded-lg border border-kumo-line p-4">
        <FeedbackSummary view={view} />
        {review.notice ? <p role="alert">{review.notice}</p> : null}
        {query.isError ? (
          <p role="alert">{m.im_feedback_unavailable()}</p>
        ) : (
          <FeedbackControls view={view} operation={operation} review={review} />
        )}
      </section>
      <Collapsible.Root className="space-y-3 rounded-lg border border-kumo-line p-4">
        <Collapsible.DefaultTrigger>{m.im_feedback_details()}</Collapsible.DefaultTrigger>
        <Collapsible.Panel className="space-y-3">
          <p>{m.im_feedback_code({ code: view.errorCode ?? "—" })}</p>
          <p className="break-all">{m.im_feedback_source({ session: view.sessionId })}</p>
          <Link {...agentTaskDetailLink(view.agentId, view.taskId)}>{m.im_feedback_task()}</Link>
        </Collapsible.Panel>
      </Collapsible.Root>
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="secondary" onClick={() => void query.refetch()} disabled={review.submitting}>
          {m.im_feedback_refresh()}
        </Button>
        <Link {...agentDetailLink(view.agentId)}>{m.im_feedback_back()}</Link>
      </div>
    </FeedbackFrame>
  );
}
