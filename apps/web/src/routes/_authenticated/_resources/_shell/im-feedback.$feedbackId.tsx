import { ImFeedbackActionKindSchema } from "@opentag/shared/browser";
import { createFileRoute } from "@tanstack/react-router";
import { ImFeedbackPage } from "../../../../features/im-feedback-page.js";
export const Route = createFileRoute("/_authenticated/_resources/_shell/im-feedback/$feedbackId")({
  component: FeedbackRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    operation: ImFeedbackActionKindSchema.safeParse(search.operation).success
      ? ImFeedbackActionKindSchema.parse(search.operation)
      : undefined,
  }),
});
function FeedbackRoute() {
  const { feedbackId } = Route.useParams();
  const { operation } = Route.useSearch();
  return <ImFeedbackPage feedbackId={feedbackId} operation={operation} />;
}
