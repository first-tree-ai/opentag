import type { TaskInternalSession, TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";

export type TaskInternalSessionItem = TaskInternalSession & {
  title?: string | null;
  status?: TaskStatus;
};

/**
 * One page of the Task detail as the Web reads it: the summary, the Turns, optional Internal
 * Sessions when present, and the cursor the conversation continues with. The summary is present on
 * the first page only; a later Turn page has none to repeat.
 */
export interface TaskDetailView {
  task?: TaskSummary;
  turns: TaskTurn[];
  internalSessions?: TaskInternalSessionItem[];
  nextCursor: string | null;
}
