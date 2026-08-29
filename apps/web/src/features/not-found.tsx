import { Link } from "@tanstack/react-router";
import { Text } from "../ui/design-system.js";

export function NotFoundPage() {
  return (
    <section
      className="mx-auto grid max-w-xl gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
      data-ui="not-found"
    >
      <Text as="h1" size="lg" variant="heading">
        Page not found
      </Text>
      <Text as="p" variant="secondary">
        The requested OpenTag page is not available.
      </Text>
      <Link to="/agents">Back to Agents</Link>
    </section>
  );
}

export function StandaloneNotFoundPage() {
  return (
    <main className="mx-auto grid max-w-xl gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-line" data-ui="not-found">
      <Text as="h1" size="lg" variant="heading">
        Page not found
      </Text>
      <Text as="p" variant="secondary">
        The requested OpenTag page is not available.
      </Text>
      <Link to="/agents">Back to Agents</Link>
    </main>
  );
}
