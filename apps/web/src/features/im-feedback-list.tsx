import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { browserApi } from "../api.js";
import { m } from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { Button } from "../ui/design-system.js";

/**
 * Recovery and error notices for an Agent. With none there is nothing to open, so the section is not
 * shown at all; otherwise it stays collapsed and names how many there are. The first page is read up
 * front to know that; a failed first read hides the section, since it is a diagnostic, not a task. Once
 * notices are on screen, a failed later page keeps them, says the read failed, and keeps Load more as
 * the retry.
 */
export function ImFeedbackList({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    queryKey: queryKeys.imFeedbackList(agentId),
    queryFn: ({ pageParam }) => browserApi.imFeedbackList(agentId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const loaded = query.data?.pages.flatMap((page) => page.items).length ?? 0;
  if (!query.data || loaded === 0) return null;
  const count = query.hasNextPage ? `${loaded}+` : String(loaded);
  return (
    <section className="space-y-3 rounded-lg border border-kumo-line p-4" data-ui="im-feedback-list">
      <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        {m.im_feedback_history_with_count({ count })}
      </Button>
      {open ? (
        <div className="space-y-3">
          <ul className="space-y-3">
            {query.data.pages
              .flatMap((page) => page.items)
              .map((item) => (
                <li key={item.id}>
                  <Link
                    className="break-all text-kumo-link"
                    to="/im-feedback/$feedbackId"
                    params={{ feedbackId: item.id }}
                    search={{ operation: undefined, open: undefined }}
                  >
                    {m.im_feedback_code({ code: item.errorCode ?? item.state })}
                  </Link>
                  {item.deliveryState === "send_unknown" ? (
                    <p className="text-sm">{m.im_feedback_card_unknown()}</p>
                  ) : null}
                </li>
              ))}
          </ul>
          {query.isFetchNextPageError ? <p role="alert">{m.im_feedback_more_failed()}</p> : null}
          {query.hasNextPage ? (
            <Button variant="secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {m.im_feedback_more()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
