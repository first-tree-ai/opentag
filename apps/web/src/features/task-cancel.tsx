import type { TaskDetail, TaskSummary } from "@opentag/shared/browser";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { Banner, Button, Dialog } from "../ui/design-system.js";

/**
 * Withdraws a Task that is still waiting in the queue. Only a `queued` Task offers the control:
 * once work has started there is nothing queued to act on. The Server says so with a 409 when the
 * Task started between the read and the click, and that answer refreshes the Task rather than
 * reporting a failure — the reader learns the true state, which is what they were after. The same
 * 409 also answers a Task whose queued message a worker is delivering at that moment; that Task
 * still reads as queued after the refresh, so the notice says the cancel did not happen rather
 * than that the Task left the queue. A success is announced from the status the Server returned
 * for the same reason: only a Task that now reads `cancelled` was cancelled.
 *
 * The control stays mounted whatever the status, so the outcome it announces survives the
 * status change that removes its button.
 */
/**
 * What the Task's status, as the Server last reported it, means for the cancel the reader asked
 * for: `cancelled` is the cancel itself; `queued` means a worker holds the queued message — being
 * delivered, or awaiting the Computer's confirmation — and nothing was withdrawn; anything else means
 * the Task left the queue on its own.
 */
function noticeFor(status: TaskSummary["status"] | undefined): string {
  if (status === "cancelled") return m.tasks_cancelled_notice();
  if (status === "queued") return m.tasks_cancel_in_flight();
  return m.tasks_cancel_not_queued();
}

export function TaskCancelControl({
  detailKey,
  enabled = true,
  task,
}: {
  detailKey: readonly unknown[];
  /** Off for the local example Tasks, which no Server knows. */
  enabled?: boolean;
  task: TaskSummary;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const buttonRef = useRef<HTMLButtonElement>(null);

  function close() {
    setConfirming(false);
    setDialogError(undefined);
  }

  /** The request reached a verdict: announce it and re-read every Task view, list and detail alike. */
  function settle(text: string) {
    setNotice(text);
    close();
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all() });
  }

  /**
   * The Server refused because there was nothing it could withdraw. Which of its two reasons
   * applies shows in the refreshed Task: one that left the queue reads as whatever it became,
   * while one whose queued message is on its way to the Agent still reads as queued.
   */
  async function settleRefused() {
    close();
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all() });
    setNotice(noticeFor(queryClient.getQueryData<InfiniteData<TaskDetail>>(detailKey)?.pages[0]?.task.status));
  }

  async function cancel() {
    setBusy(true);
    setDialogError(undefined);
    try {
      const cancelled = await browserApi.cancelTask(task.id);
      // The summary answers at once; the Turns it withdrew arrive with the revalidation.
      queryClient.setQueryData<InfiniteData<TaskDetail>>(detailKey, (data) =>
        data
          ? { ...data, pages: data.pages.map((page, index) => (index === 0 ? { ...page, task: cancelled } : page)) }
          : data,
      );
      settle(noticeFor(cancelled.status));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await settleRefused();
      else setDialogError(error instanceof ApiError ? error.message : m.tasks_cancel_failed());
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  return (
    <div className="grid gap-3" data-ui="task-actions">
      {notice ? <Banner description={notice} role="status" variant="secondary" /> : null}
      {task.status === "queued" ? (
        <Button
          className="w-fit"
          ref={buttonRef}
          type="button"
          variant="secondary-destructive"
          onClick={() => setConfirming(true)}
        >
          {m.tasks_cancel_queued()}
        </Button>
      ) : null}
      {confirming ? (
        <Dialog
          busy={busy}
          description={m.tasks_cancel_confirm_description()}
          returnFocusRef={buttonRef}
          role="alertdialog"
          title={m.tasks_cancel_confirm_title()}
          onClose={close}
        >
          <div className="grid gap-4">
            {dialogError ? <Banner description={dialogError} role="alert" variant="error" /> : null}
            <div className="flex flex-wrap justify-end gap-3">
              <Button disabled={busy} type="button" variant="ghost" onClick={close}>
                {m.tasks_cancel_keep_queued()}
              </Button>
              <Button disabled={busy} type="button" variant="danger" onClick={() => void cancel()}>
                {busy ? m.tasks_cancelling() : m.tasks_cancel_confirm_button()}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
