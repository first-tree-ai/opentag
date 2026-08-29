import { vi } from "vitest";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";

/**
 * A Better Auth instance that recognizes one browser session.
 *
 * Route tests care about what happens after a browser is signed in, not about how the cookie is parsed, so they stub
 * the session lookup rather than standing up a real instance. The `getSession` seam is the same one the preHandler
 * uses, so a test that stops resolving here is one where the route genuinely stopped authenticating.
 */
export const SESSION_COOKIE_NAME = "opentag.session_token";

export function signedInBrowser(
  userId: string,
  options: { expiresAt?: Date; publicUrl?: string } = {},
): { instance: OpenTagBetterAuth; publicUrl: string } {
  const expiresAt = options.expiresAt ?? new Date("2030-01-01T00:00:00.000Z");
  const instance = {
    $context: Promise.resolve({ authCookies: { sessionToken: { name: SESSION_COOKIE_NAME } } }),
    api: {
      /*
       * Answers only when the request actually carries the session cookie. A stub that resolved unconditionally would
       * quietly pass every "requires authentication" test in the file, including one where the route stopped checking.
       */
      getSession: vi.fn(async ({ headers, returnHeaders }: { headers: Headers; returnHeaders?: boolean }) => {
        const session = headers.get("cookie")?.includes(`${SESSION_COOKIE_NAME}=`)
          ? { session: { expiresAt, token: "session-token" }, user: { id: userId } }
          : null;
        /*
         * The pre-handler asks for headers so it can forward Better Auth's rolling renewal. Answering with the bare
         * session there would make every caller of this stub look unauthenticated, which is a stub bug rather than a
         * route one — so the shape follows the option, as the library's does.
         */
        return returnHeaders ? { headers: new Headers(), response: session } : session;
      }),
    },
    handler: vi.fn(async () => new Response(null, { status: 200 })),
  } as unknown as OpenTagBetterAuth;
  return { instance, publicUrl: options.publicUrl ?? "https://opentag.example.com" };
}
