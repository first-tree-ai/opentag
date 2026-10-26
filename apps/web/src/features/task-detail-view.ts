import type { TaskSummary, TaskTurn } from "@opentag/shared/browser";

/**
 * One page of the Task detail as the Web reads it: the summary, the Turns, and the cursor the
 * conversation continues with. The summary is present on the first page only; a later Turn page has
 * none to repeat. The Server's other two sections — Internal Sessions and collaboration messages —
 * are not read here because no view renders them.
 */
export interface TaskDetailView {
  task?: TaskSummary;
  turns: TaskTurn[];
  nextCursor: string | null;
}
