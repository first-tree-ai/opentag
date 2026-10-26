import type { TaskDetail, TaskDetailPage } from "@opentag/shared/browser";
import { vi } from "vitest";
import { browserApi } from "../../api.js";

/**
 * The Web reads the bounded Task detail: the first page from `taskDetail` with only the sections it
 * renders, and every later conversation page from `taskTurns`. These fixtures are written as whole
 * detail pages, exactly as the views assert on them, so `detailPage` splits one into the section
 * pages the Server sends — honouring the requested sections, as the Server does — and `mockDetail`
 * queues the pages in request order and answers each call in the shape it expects. An `Error` in the
 * queue stands for a refused request.
 */
export function detailPage(detail: TaskDetail, sections?: readonly string[]): TaskDetailPage {
  const wants = (section: string) => sections === undefined || sections.includes(section);
  return {
    task: detail.task,
    ...(wants("turns") ? { turns: { items: detail.turns, nextCursor: detail.nextCursor } } : {}),
    ...(wants("internal-sessions") ? { internalSessions: { items: detail.internalSessions, nextCursor: null } } : {}),
    ...(wants("collaboration-messages")
      ? { collaborationMessages: { items: detail.collaborationMessages, nextCursor: null } }
      : {}),
  };
}

export function mockDetail(...responses: (TaskDetail | Error)[]) {
  if (responses.length === 0) responses = [new Error("No Task detail response was declared")];
  const queue = [...responses];
  function take(): TaskDetail {
    // The last response repeats, the way a `mockResolvedValue` fixture does, so a revalidation
    // after the listed pages still answers instead of failing on an empty queue.
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error("No Task detail response left for this request");
    if (next instanceof Error) throw next;
    return next;
  }
  const detail = vi
    .spyOn(browserApi, "taskDetail")
    .mockImplementation(async (_sessionId, sections) => detailPage(take(), sections));
  const turns = vi.spyOn(browserApi, "taskTurns").mockImplementation(async () => {
    const page = take();
    return { items: page.turns, nextCursor: page.nextCursor };
  });
  return { detail, turns };
}
