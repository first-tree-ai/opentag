import type { TaskCollaborationMessage, TaskInternalSession, TaskSummary, TaskTurn } from "@opentag/shared/browser";

/**
 * One page of the Task detail as the Web reads it. The Server sends each section with its own
 * cursor; the view keeps the first page's section rows and the Turn cursor the conversation
 * continues with, so "Load earlier activity" pages the Turns and nothing else.
 */
export interface TaskDetailView {
  /** Present on the first page only; a later Turn page has no summary to repeat. */
  task?: TaskSummary;
  turns: TaskTurn[];
  internalSessions: TaskInternalSession[];
  collaborationMessages: TaskCollaborationMessage[];
  nextCursor: string | null;
}
