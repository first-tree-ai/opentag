import { useEffect } from "react";
import { Redirect } from "../navigation/redirect.js";

/**
 * Landing on a sign-in destination that is a server route rather than a page.
 *
 * The router can only reach paths it has a route for, so a destination such as
 * `/api/v1/mcp-servers/oauth/handoff?token=…` cannot be navigated to client-side: the router has no
 * match, the app falls through to its not-found surface, and the request that destination exists for
 * is never sent. The MCP OAuth handoff is exactly that: it is a Fastify route that sets the flow
 * cookie and redirects to the provider, and skipping it leaves the flow unredeemed.
 *
 * A full document navigation is what sends the request. It is used only for server paths; everything
 * else stays a client-side replace, which keeps an ordinary sign-in from reloading the app.
 */
export function isServerDestination(destination: string): boolean {
  return destination.startsWith("/api/");
}

/**
 * Send the browser to `href` and let the network request happen.
 *
 * `navigate` is injectable so a test can observe where the landing decided to go instead of following
 * it; nothing in the app passes it.
 */
export function NativeRedirect({
  href,
  navigate = (to: string) => window.location.replace(to),
}: {
  href: string;
  navigate?: (to: string) => void;
}) {
  useEffect(() => {
    navigate(href);
  }, [href, navigate]);
  return null;
}

/** Land on a resolved sign-in destination, by the mechanism that can actually arrive there. */
export function SignInLanding({ destination, navigate }: { destination: string; navigate?: (to: string) => void }) {
  if (isServerDestination(destination)) {
    return <NativeRedirect href={destination} {...(navigate === undefined ? {} : { navigate })} />;
  }
  return <Redirect href={destination} replace />;
}
