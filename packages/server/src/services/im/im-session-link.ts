import type { DatabaseClient } from "../../db/client.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { TaskService } from "../tasks/index.js";

/**
 * Whether the Session ID line of an IM failure message may link to the Session's Task page: only when that Task
 * qualifies under the rule the Task list uses, so the link never opens a 404. A failed lookup keeps the plain ID.
 */
export async function hasLinkableSessionTask(
  database: DatabaseClient,
  sessionId: string,
  logger?: Pick<ServiceLogger, "warn">,
): Promise<boolean> {
  try {
    return await new TaskService(database).hasLinkableTask(sessionId);
  } catch (error) {
    logger?.warn(
      {
        code: "IM_FEEDBACK_SESSION_LINK_LOOKUP_FAILED",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to resolve the Task of an IM failure message's Session",
    );
    return false;
  }
}

/** The Task page that a Session ID opens; the Task routes accept any Session id of the Task. */
export function sessionTaskUrl(publicUrl: string, agentId: string, sessionId: string): string {
  return new URL(`/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(sessionId)}`, publicUrl).href;
}
