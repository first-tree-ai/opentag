import type { TaskStatus } from "@opentag/shared/browser";
import * as m from "../paraglide/messages.js";
import type { StatusTone } from "../ui/design-system.js";

/**
 * The four states an Account reads a Task in. The Server reports a finer status so other clients
 * can act on it (the cancel control needs `queued` and `cancelled` exactly), but the page only
 * answers "is it waiting, is it working, did it finish, did it go wrong".
 */
export const TASK_STATUS_GROUPS = ["queued", "running", "completed", "failed"] as const;
export type TaskStatusGroup = (typeof TASK_STATUS_GROUPS)[number];

/*
 * A withdrawn Task and one whose conversation ended both stopped without anything going wrong, so
 * they read as completed. An expired Task never reported an outcome, so it reads as failed. `idle`
 * cannot occur for a listed Task and falls back to completed rather than to an alarming state.
 */
const groupByStatus: Record<TaskStatus, TaskStatusGroup> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  cancelled: "completed",
  ended: "completed",
  idle: "completed",
  failed: "failed",
  expired: "failed",
};

const toneByGroup: Record<TaskStatusGroup, StatusTone> = {
  queued: "info",
  running: "info",
  completed: "success",
  failed: "danger",
};

export function taskStatusGroup(status: TaskStatus): TaskStatusGroup {
  return groupByStatus[status];
}

export function taskStatusGroupTone(group: TaskStatusGroup): StatusTone {
  return toneByGroup[group];
}

export function taskStatusGroupLabel(group: TaskStatusGroup): string {
  if (group === "queued") return m.tasks_status_queued();
  if (group === "running") return m.tasks_status_running();
  if (group === "completed") return m.tasks_status_completed();
  return m.tasks_status_failed();
}
