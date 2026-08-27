import { ErrorCodeSchema } from "@opentag/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appendSetCookies, setBrowserCsrfCookie } from "../services/auth/browser-cookies.js";
import { AuthServiceError } from "../services/auth/errors.js";
import { BETTER_AUTH_BASE_PATH, type OpenTagBetterAuth } from "./better-auth.js";

/**
 * The only Better Auth endpoint OpenTag publishes.
 *
 * Better Auth's handler serves its whole surface from one catch-all, including `/update-user` — a second Account
 * profile writer that bypasses `UserDisplayNameSchema`, the suspension guard, and the canonical `/api/v1/me` boundary.
 * Registering paths individually keeps that surface closed: an endpoint is reachable because it is listed here, not
 * because the library happens to define it.
 *
 * Only the OAuth callback has to be served by the library, because the provider redirects the browser straight to it.
 * Every other step runs through an OpenTag route that calls into Better Auth server-side, so the request contract,
 * the origin check, and the response shape all stay ours.
 */
const PUBLISHED_PATHS = [{ method: "GET" as const, path: "/callback/:provider" }];

export interface BetterAuthRoutesOptions {
  publicUrl: string;
  secureCookies: boolean;
  /** Matches the session lifetime the double-submit token accompanies. */
  sessionTtlSeconds: number;
}

export function registerBetterAuthRoutes(
  app: FastifyInstance,
  auth: OpenTagBetterAuth,
  options: BetterAuthRoutesOptions,
): void {
  const publicUrl = options.publicUrl;
  app.register(async (authApp) => {
    authApp.removeAllContentTypeParsers();
    authApp.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    for (const { method, path } of PUBLISHED_PATHS) {
      authApp.route({
        method,
        url: `${BETTER_AUTH_BASE_PATH}${path}`,
        handler: async (request, reply) => {
          const response = await callBetterAuth(auth, publicUrl, request);
          /*
           * A Better Auth sign-in issues its own session cookie and knows nothing about OpenTag's double-submit
           * token, which every browser mutation — including sign-out — requires. Issuing it alongside the session is
           * what makes a freshly signed-in browser able to write at all.
           */
          if (await isSessionEstablished(auth, response)) {
            setBrowserCsrfCookie(reply, {
              maxAgeSeconds: options.sessionTtlSeconds,
              secure: options.secureCookies,
            });
          }
          return sendBetterAuthResponse(reply, response);
        },
      });
    }
  });
}

/** Overrides for driving a Better Auth endpoint that the browser did not address directly. */
export interface BetterAuthCall {
  body?: unknown;
  method?: "GET" | "POST";
  /** Path below the Better Auth base path, for example `/sign-out`. */
  path?: string;
}

/**
 * Runs one Better Auth endpoint and returns its raw response.
 *
 * The URL is built from the configured public URL rather than the Host header, so a spoofed Host cannot move the
 * origin Better Auth validates against.
 */
export async function callBetterAuth(
  auth: OpenTagBetterAuth,
  publicUrl: string,
  request: FastifyRequest,
  call: BetterAuthCall = {},
): Promise<Response> {
  const target = call.path === undefined ? request.url : `${BETTER_AUTH_BASE_PATH}${call.path}`;
  const url = new URL(target, publicUrl);
  const method = call.method ?? request.method;
  const headers = fromNodeHeaders(request.headers);
  let body: Buffer | string | undefined;
  if (call.body !== undefined) {
    body = JSON.stringify(call.body);
    headers.set("content-type", "application/json");
  } else if (Buffer.isBuffer(request.body) && request.body.length > 0) {
    body = request.body;
  }
  // A forwarded body is this request's, not the incoming one's; a stale length would truncate or hang the read.
  headers.delete("content-length");
  return auth.handler(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }));
}

/**
 * Copies Better Auth's cookies onto a reply.
 *
 * `set-cookie` must come from `Headers.getSetCookie()`: iterating the `Headers` object folds multiple cookies into one
 * comma-joined value that browsers reject, which would silently break every session cookie.
 */
export function copyBetterAuthCookies(reply: FastifyReply, response: Response): void {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) appendSetCookies(reply, setCookies);
}

/** Copies a Better Auth response onto a reply verbatim. */
export async function sendBetterAuthResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.status(response.status);
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    reply.header(key, value);
  }
  copyBetterAuthCookies(reply, response);
  if (!response.body) return reply.send(null);
  return reply.send(Buffer.from(await response.arrayBuffer()));
}

/**
 * Restates a failed Better Auth call in OpenTag's error envelope.
 *
 * Better Auth replies in its own shape, which the client would read as an unrecognized failure and flatten. The status
 * and code an OpenTag endpoint reported are carried across so a rejected credential and a suspended Account stay
 * distinguishable; anything else becomes the caller's fallback rather than being guessed at.
 */
export async function betterAuthFailure(response: Response, fallback: AuthServiceError): Promise<AuthServiceError> {
  const body = (await response.json().catch(() => undefined)) as { code?: unknown; message?: unknown } | undefined;
  const code = ErrorCodeSchema.safeParse(body?.code);
  if (!code.success || typeof body?.message !== "string") return fallback;
  return new AuthServiceError(code.data, fallback.category, body.message, response.status);
}

/** Whether a Better Auth response handed the browser a session cookie. */
async function isSessionEstablished(auth: OpenTagBetterAuth, response: Response): Promise<boolean> {
  const sessionCookieName = (await auth.$context).authCookies.sessionToken.name;
  return response.headers.getSetCookie().some((value) => value.split("=", 1)[0]?.trim() === sessionCookieName);
}
