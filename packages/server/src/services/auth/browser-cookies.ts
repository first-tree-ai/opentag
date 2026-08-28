import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthServiceError } from "./errors.js";
import { generateSecret } from "./security.js";

export const BROWSER_COOKIE_NAMES = {
  csrf: "opentag_csrf",
  slackOAuthContext: "opentag_slack_oauth_context",
} as const;

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {}
  }
  return cookies;
}

function cookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number; path: string; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join("; ");
}

/**
 * Issues the readable half of the double-submit pair on its own.
 *
 * A Better Auth sign-in brings its own session cookie but knows nothing about this one, and every browser mutation —
 * including sign-out — requires it. Without this, a session issued by Better Auth can read but never write.
 */
export function setBrowserCsrfCookie(
  reply: FastifyReply,
  options: { maxAgeSeconds: number; secure: boolean; value?: string },
): string {
  // An existing token is re-sent unchanged when only its lifetime is being extended; a new sign-in mints a fresh one.
  const csrf = options.value ?? generateSecret(24);
  appendSetCookies(reply, [
    cookie(BROWSER_COOKIE_NAMES.csrf, csrf, { maxAge: options.maxAgeSeconds, path: "/", secure: options.secure }),
  ]);
  return csrf;
}

/** Retires the double-submit token, which is OpenTag's and so outlives Better Auth's own sign-out. */
export function clearBrowserCsrfCookie(reply: FastifyReply, secure: boolean): void {
  appendSetCookies(reply, [cookie(BROWSER_COOKIE_NAMES.csrf, "", { maxAge: 0, path: "/", secure })]);
}

export function setSlackOAuthContextCookie(
  reply: FastifyReply,
  value: string,
  options: { path: string; secure: boolean; maxAge?: number },
): void {
  appendSetCookies(reply, [
    cookie(BROWSER_COOKIE_NAMES.slackOAuthContext, value, {
      httpOnly: true,
      maxAge: options.maxAge ?? 600,
      path: options.path,
      secure: options.secure,
    }),
  ]);
}

export function clearSlackOAuthContextCookie(reply: FastifyReply, path: string, secure: boolean): void {
  appendSetCookies(reply, [
    cookie(BROWSER_COOKIE_NAMES.slackOAuthContext, "", {
      httpOnly: true,
      maxAge: 0,
      path,
      secure,
    }),
  ]);
}

export function requireBrowserMutationSecurity(request: FastifyRequest, publicOrigin: string): void {
  if (request.headers.origin !== publicOrigin) {
    throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The browser request origin is invalid", 403);
  }
  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = cookies[BROWSER_COOKIE_NAMES.csrf];
  const headerToken = request.headers["x-opentag-csrf"];
  if (!cookieToken || typeof headerToken !== "string" || !safeEqual(cookieToken, headerToken)) {
    throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The browser CSRF token is invalid", 403);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

export function appendSetCookies(reply: FastifyReply, values: string[]): void {
  const current = reply.getHeader("set-cookie");
  const existing = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  reply.header("set-cookie", [...existing, ...values]);
}
