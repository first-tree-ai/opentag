import { useQuery } from "@tanstack/react-query";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { liveResourceQueryOptions } from "../../../query/live.js";
import { Banner } from "../../../ui/design-system.js";
import { isTerminalResourceError, usePersistedSettledError } from "../../resource/resource-state.js";

/** Read existing diagnostics without exposing or controlling individual environments. */
async function readSaveFailure(agentId: string) {
  let cursor: string | undefined;
  do {
    const page = await browserApi.agentCloudOverview(agentId, { limit: 100, ...(cursor ? { cursor } : {}) });
    if (page.sessions.some((session) => session.lastErrorCode === "workspace_save_failed")) return true;
    if (page.counts.attention === 0) return false;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return false;
}

export function CloudProgressNotice({ agentId }: { agentId: string }) {
  const queryKey = queryKeys.agents.progressNotice(agentId);
  const query = useQuery({
    queryKey,
    queryFn: () => readSaveFailure(agentId),
    ...liveResourceQueryOptions,
  });
  const settledError = usePersistedSettledError(queryKey, query);
  // A failed diagnostic read is not evidence that progress was lost. Retain known failures on
  // transient refresh errors, but do not expose cached facts after access has been revoked.
  if ((settledError && isTerminalResourceError(settledError)) || !query.data) return null;
  return <Banner description={m.cloud_progress_save_failed()} role="alert" variant="error" />;
}
