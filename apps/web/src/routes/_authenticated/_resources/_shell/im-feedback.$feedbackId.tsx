import { ImFeedbackActionKindSchema } from "@opentag/shared/browser";
import { createFileRoute } from "@tanstack/react-router";
import { ImFeedbackDestinationPage, type ImFeedbackLink } from "../../../../features/im-feedback-destination-page.js";
import { ImFeedbackPage } from "../../../../features/im-feedback-page.js";

const LINKS: readonly ImFeedbackLink[] = ["settings", "task", "restore", "agent"];
export const Route = createFileRoute("/_authenticated/_resources/_shell/im-feedback/$feedbackId")({
  component: FeedbackRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    operation: ImFeedbackActionKindSchema.safeParse(search.operation).success
      ? ImFeedbackActionKindSchema.parse(search.operation)
      : undefined,
    open: LINKS.find((link) => link === search.open),
  }),
});
function FeedbackRoute() {
  const { feedbackId } = Route.useParams();
  const { operation, open } = Route.useSearch();
  if (open) return <ImFeedbackDestinationPage feedbackId={feedbackId} link={open} />;
  return <ImFeedbackPage feedbackId={feedbackId} operation={operation} />;
}
