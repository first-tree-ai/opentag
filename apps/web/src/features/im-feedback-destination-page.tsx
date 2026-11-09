import type { ImFeedbackDestination } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { m } from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { agentDetailLink, agentSettingsSectionLink, agentTaskDetailLink } from "./agents/agent-routes.js";
import { Redirect } from "./navigation/redirect.js";

export type ImFeedbackLink = "settings" | "task" | "restore" | "agent";

function ownerOnly(link: ImFeedbackLink): string {
  if (link === "settings") return m.im_feedback_owner_only_settings();
  if (link === "agent") return m.im_feedback_owner_only_agent();
  return link === "restore" ? m.im_feedback_owner_only_restore() : m.im_feedback_owner_only_task();
}

function destinationLink(link: ImFeedbackLink, destination: Extract<ImFeedbackDestination, { owner: true }>) {
  if (link === "task") return agentTaskDetailLink(destination.agentId, destination.taskId);
  if (link === "agent") return agentDetailLink(destination.agentId);
  return agentSettingsSectionLink(destination.agentId, link === "settings" ? "execution" : "computer");
}

/**
 * A link in an IM card. Everyone in the conversation sees the same link, so the reader is only known here:
 * the Agent owner goes straight on, and anyone else learns who can act on it.
 */
export function ImFeedbackDestinationPage({
  feedbackId,
  link,
  api = browserApi,
}: {
  feedbackId: string;
  link: ImFeedbackLink;
  api?: Pick<typeof browserApi, "imFeedbackDestination">;
}) {
  const query = useQuery({
    queryKey: queryKeys.imFeedbackDestination(feedbackId),
    queryFn: () => api.imFeedbackDestination(feedbackId),
    retry: false,
  });
  const destination = query.data;
  if (destination?.owner) return <Redirect {...destinationLink(link, destination)} replace />;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <PageHeader title={destination ? ownerOnly(link) : m.im_feedback_title()} />
      {query.isPending ? <p role="status">{m.im_feedback_opening()}</p> : null}
      {destination ? (
        <p>{m.im_feedback_owner_is({ agent: destination.agentName, owner: destination.ownerDisplayName })}</p>
      ) : null}
      {query.isError ? <p role="alert">{m.im_feedback_unavailable()}</p> : null}
      {query.isPending ? null : (
        <Link className="text-kumo-link" to="/agents">
          {m.im_feedback_go_agents()}
        </Link>
      )}
    </div>
  );
}
