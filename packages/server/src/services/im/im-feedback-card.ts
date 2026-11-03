import type { TurnFailureReason } from "@opentag/shared";
import type { FeedbackAction, FeedbackTarget } from "./im-feedback-store.js";

const CAUSES = {
  provider_authentication_failed: "Model authentication failed",
  provider_access_denied: "Model access was denied",
  provider_quota_exceeded: "Model quota was exhausted",
  provider_rate_limited: "The model service rate limit was reached",
  provider_unavailable: "The model service is unavailable",
  provider_connection_failed: "The model connection failed",
  provider_context_limit: "The model context limit was reached",
  provider_execution_limit: "The model execution limit was reached",
  provider_request_rejected: "The model request was rejected",
  provider_process_exited: "The model process stopped",
  workspace_failed: "Workspace changes could not be saved",
  configuration_conflict: "The execution configuration changed",
  credential_unavailable: "Execution credentials are unavailable",
  sandbox_unavailable: "The execution environment disconnected",
  provider_start_failed: "The model could not start",
  session_resume_failed: "The Session could not resume",
  provider_protocol_error: "The model returned an invalid response",
  provider_failed: "The model execution failed",
  provider_empty_result: "The model returned no result",
  output_too_large: "The execution result exceeded its size limit",
  provider_teardown_failed: "The execution environment could not finish cleanup",
  turn_state_unknown: "The task outcome could not be confirmed",
  turn_timeout: "The task exceeded its time limit",
  client_shutdown: "The execution client stopped",
} satisfies Record<TurnFailureReason, string>;

export function feedbackCause(code: string | null): string {
  if (code === "input_expired") return "The queued input expired before completion";
  if (code === "input_rejected") return "The input could not be delivered";
  return code && Object.hasOwn(CAUSES, code) ? CAUSES[code as TurnFailureReason] : "The task could not complete";
}

function actionResult(action?: FeedbackAction): string | undefined {
  if (!action) return;
  if (["confirmed", "submitting", "checking"].includes(action.state))
    return "Checking the operation result; do not submit it again";
  if (action.state === "failed") return "The operation failed; review the current state before trying again";
  if (action.state === "stale") return "The environment changed; review its current state";
  if (action.state !== "succeeded") return;
  if (action.resultCode === "released_unverified")
    return "Environment released; verify saved changes before continuing";
  if (action.kind === "save_release") return "Saved and environment released; the next allocation restores it";
  if (action.kind === "discard") return "Unsaved changes discarded; previous complete archive retained";
  return "Retry queued";
}

export function feedbackCardContent(target: FeedbackTarget, action?: FeedbackAction) {
  const resolved = action?.state === "succeeded";
  const checking = action && ["confirmed", "submitting", "checking"].includes(action.state);
  const result = actionResult(action);
  const attribution = action ? ` · ${action.actorDisplayName.slice(0, 255)} · ${action.updatedAt.toISOString()}` : "";
  const title = result
    ? `${resolved ? "✅" : checking ? "⏳" : "⚠️"} ${result}${attribution}`
    : `Task failed: ${feedbackCause(target.errorCode)}`;
  const impact =
    target.effects === "not_started"
      ? "The task did not start. No task operations were executed."
      : "External operations may already have occurred. Check the existing results before repeating this task.";
  const availability =
    target.state === "workspace_blocked"
      ? "Work in this Session is paused; new input for this Session remains queued. Saving or discarding files will not undo external operations."
      : "Check the Agent's current availability before starting another attempt.";
  return { title, impact, availability, result: !!result, checking: !!checking };
}

function cardActions(target: FeedbackTarget, result: boolean, operationUrl: (kind: string) => string) {
  if (result) return [];
  if (target.state === "workspace_blocked")
    return [
      { kind: "save_release", label: "Retry save", url: operationUrl("save_release"), style: "primary" as const },
      { kind: "discard", label: "Discard unsaved changes", url: operationUrl("discard"), style: "danger" as const },
    ];
  return [
    {
      kind: "retry_task",
      label: target.effects === "not_started" ? "Retry" : "Check retry eligibility",
      url: operationUrl("retry_task"),
      style: "primary" as const,
    },
  ];
}

export function renderFeedbackCard(target: FeedbackTarget, publicUrl: string, action?: FeedbackAction) {
  const content = feedbackCardContent(target, action);
  const detailsUrl = new URL(`/im-feedback/${encodeURIComponent(target.id)}`, publicUrl).href;
  const operationUrl = (kind: string) => {
    const u = new URL(detailsUrl);
    u.searchParams.set("operation", kind);
    return u.href;
  };
  const actions = cardActions(target, content.result, operationUrl);
  const code = /^[a-zA-Z0-9_]{1,128}$/.test(target.errorCode ?? "") ? target.errorCode : "task_failed";
  const text = content.result
    ? content.title
    : `${content.title}\n\n${content.impact}\n\n${content.availability}\n\n${code}`;
  const canNativeRetry = target.state === "failed" && target.effects === "not_started" && !content.result;
  return {
    slack: {
      text,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        {
          type: "section" as const,
          block_id: `opentag_feedback:${target.id}`,
          text: { type: "plain_text" as const, text: content.title },
        },
        ...(!content.result
          ? [
              { type: "section" as const, text: { type: "plain_text" as const, text: content.impact } },
              { type: "section" as const, text: { type: "plain_text" as const, text: content.availability } },
            ]
          : []),
        {
          type: "actions" as const,
          elements: [
            ...actions.map((a) => ({
              type: "button" as const,
              text: { type: "plain_text" as const, text: a.label },
              style: a.style,
              ...(a.kind === "retry_task" && canNativeRetry
                ? { action_id: "opentag_feedback_retry", value: `${target.id}:${target.revision}` }
                : { action_id: `opentag_feedback_${a.kind}`, url: a.url }),
            })),
            {
              type: "button" as const,
              text: { type: "plain_text" as const, text: "View details" },
              action_id: "opentag_feedback_details",
              url: detailsUrl,
            },
          ],
        },
        ...(!content.result
          ? [{ type: "context" as const, elements: [{ type: "plain_text" as const, text: code ?? "task_failed" }] }]
          : []),
      ],
    },
    feishu: JSON.stringify({
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: "plain_text", content: content.result ? "Task status" : "Task failed" },
        template: action?.state === "succeeded" ? "green" : "red",
      },
      elements: [
        { tag: "div", text: { tag: "plain_text", content: content.title } },
        ...(!content.result
          ? [
              { tag: "div", text: { tag: "plain_text", content: content.impact } },
              { tag: "div", text: { tag: "plain_text", content: content.availability } },
            ]
          : []),
        {
          tag: "action",
          actions: [
            ...actions.map((a) => ({
              tag: "button",
              text: { tag: "plain_text", content: a.label },
              type: a.style === "danger" ? "danger" : "primary",
              ...(a.kind === "retry_task" && canNativeRetry
                ? { value: { feedbackId: target.id, revision: target.revision, kind: "retry_task" } }
                : { url: a.url }),
            })),
            { tag: "button", text: { tag: "plain_text", content: "View details" }, type: "default", url: detailsUrl },
          ],
        },
        ...(!content.result ? [{ tag: "note", elements: [{ tag: "plain_text", content: code }] }] : []),
      ],
    }),
  };
}
