import { Link } from "@tanstack/react-router";
import * as m from "../paraglide/messages.js";
import { Text } from "../ui/design-system.js";

export function NotFoundPage() {
  return (
    <section
      className="mx-auto grid max-w-xl gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
      data-ui="not-found"
    >
      <Text as="h1" size="lg" variant="heading">
        {m.errors_page_not_found()}
      </Text>
      <Text as="p" variant="secondary">
        {m.errors_page_unavailable()}
      </Text>
      <Link to="/agents">{m.errors_back_to_agents()}</Link>
    </section>
  );
}

export function StandaloneNotFoundPage() {
  return (
    <main className="mx-auto grid max-w-xl gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-line" data-ui="not-found">
      <Text as="h1" size="lg" variant="heading">
        {m.errors_page_not_found()}
      </Text>
      <Text as="p" variant="secondary">
        {m.errors_page_unavailable()}
      </Text>
      <Link to="/agents">{m.errors_back_to_agents()}</Link>
    </main>
  );
}
