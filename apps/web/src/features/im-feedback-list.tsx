import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { browserApi } from "../api.js";
import { m } from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { Button } from "../ui/design-system.js";

export function ImFeedbackList({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const query = useInfiniteQuery({
    queryKey: queryKeys.imFeedbackList(agentId),
    queryFn: ({ pageParam }) => browserApi.imFeedbackList(agentId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
    retry: false,
  });
  return (
    <section className="space-y-3 rounded-lg border border-kumo-line p-4">
      <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        {m.im_feedback_history()}
      </Button>
      {open ? (
        <div className="space-y-3">
          {query.isPending ? (
            <p>{m.im_feedback_loading()}</p>
          ) : query.isError ? (
            <p role="alert">{m.im_feedback_unavailable()}</p>
          ) : query.data?.pages.flatMap((p) => p.items).length ? (
            <ul className="space-y-3">
              {query.data.pages
                .flatMap((p) => p.items)
                .map((item) => (
                  <li key={item.id}>
                    <Link
                      className="break-all text-kumo-link"
                      to="/im-feedback/$feedbackId"
                      params={{ feedbackId: item.id }}
                      search={{ operation: undefined }}
                    >
                      {m.im_feedback_code({ code: item.errorCode ?? item.state })}
                    </Link>
                    {item.deliveryState === "send_unknown" ? (
                      <p className="text-sm">{m.im_feedback_card_unknown()}</p>
                    ) : null}
                  </li>
                ))}
            </ul>
          ) : (
            <p>{m.im_feedback_history_empty()}</p>
          )}
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
