import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteRateLimiter } from "../api/browser-auth.js";
import { createApp } from "../app.js";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

/** Stands in for the Better Auth mount, recording which endpoint a route drove rather than guessing from its effects. */
function betterAuthStub(reply: () => Response) {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const handler = vi.fn(async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    bodies.push(
      await request
        .clone()
        .json()
        .catch(() => undefined),
    );
    return reply();
  });
  const instance = {
    $context: Promise.resolve({ authCookies: { sessionToken: { name: "opentag.session_token" } } }),
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler,
  } as unknown as OpenTagBetterAuth;
  return { bodies, instance: { instance, publicUrl: "http://localhost:8000" }, paths };
}

function devSession() {
  return new Response(JSON.stringify({ userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "opentag.session_token=dev-session; Path=/; HttpOnly",
    },
  });
}

function googleRedirect() {
  return new Response(JSON.stringify({ url: "https://accounts.google.com/auth" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "opentag.state=pkce; Path=/; HttpOnly",
    },
  });
}

function passwordSession() {
  return new Response(JSON.stringify({ token: "session-token" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "opentag.session_token=password-session; Path=/; HttpOnly",
    },
  });
}

function createBrowserApp(
  options: {
    betterAuth?: { instance: OpenTagBetterAuth; publicUrl: string };
    devSignIn?: boolean;
    googleSignIn?: boolean;
    passwordSignIn?: boolean;
  } = {},
) {
  const app = createApp({
    ...(options.betterAuth ? { betterAuth: options.betterAuth } : {}),
    browserAuth: {
      ...(options.betterAuth ? { betterAuth: options.betterAuth } : {}),
      ...(options.devSignIn ? { devSignIn: true } : {}),
      ...(options.googleSignIn ? { googleSignIn: true } : {}),
      ...(options.passwordSignIn ? { passwordSignIn: true } : {}),
      publicOrigin: "http://localhost:8000",
      secureCookies: false,
      sessionTtlSeconds: 3600,
    },
  });
  apps.push(app);
  return { app };
}

const SAME_ORIGIN = { "content-type": "application/json", origin: "http://localhost:8000" };
const VALID_PASSWORD = "correct-horse-battery";

describe("browser authentication routes", () => {
  it("starts Google through Better Auth without putting next in the provider URL itself", async () => {
    const betterAuth = betterAuthStub(googleRedirect);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, googleSignIn: true });

    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toEqual({
      providers: [
        { id: "google", enabled: true, startUrl: HTTP_PATHS.authGoogleStart },
        { id: "dev", enabled: false, startUrl: null },
        { id: "password", enabled: false, startUrl: null },
      ],
    });

    const response = await app.inject({ method: "GET", url: `${HTTP_PATHS.authGoogleStart}?next=%2Fagents` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://accounts.google.com/auth");
    expect(betterAuth.paths).toEqual(["/api/v1/auth/sign-in/social"]);
    // The provider's own state and PKCE cookies have to survive the hop, or the callback cannot be verified.
    expect(String(response.headers["set-cookie"])).toContain("opentag.state=pkce");
  });

  it("refuses Google sign-in when it is not configured", async () => {
    const betterAuth = betterAuthStub(googleRedirect);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance });

    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toMatchObject({
      providers: [{ id: "google", enabled: false, startUrl: null }, { id: "dev" }, { id: "password" }],
    });
    const response = await app.inject({ method: "GET", url: HTTP_PATHS.authGoogleStart });
    expect(response.statusCode).toBe(404);
    expect(betterAuth.paths).toEqual([]);
  });

  it("rejects an external sign-in destination before reaching the provider", async () => {
    const betterAuth = betterAuthStub(googleRedirect);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, googleSignIn: true });

    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authGoogleStart}?next=${encodeURIComponent("https://example.com")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(betterAuth.paths).toEqual([]);
  });

  it("signs in the configured development user only from a loopback request", async () => {
    const betterAuth = betterAuthStub(devSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, devSignIn: true });
    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toEqual({
      providers: [
        { id: "google", enabled: false, startUrl: null },
        { id: "dev", enabled: true, startUrl: HTTP_PATHS.authDevCallback },
        { id: "password", enabled: false, startUrl: null },
      ],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: HTTP_PATHS.authProviders,
          headers: { host: "example.com" },
          remoteAddress: "127.0.0.1",
        })
      ).json(),
    ).toMatchObject({
      providers: [{ id: "google" }, { id: "dev", enabled: false, startUrl: null }, { id: "password" }],
    });

    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=%2Fagents`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/agents");
    expect(betterAuth.paths).toEqual(["/api/v1/auth/dev/sign-in"]);
    const cookies = String(response.headers["set-cookie"]);
    expect(cookies).toContain("opentag.session_token=dev-session");
    // Without the double-submit token a signed-in development browser could read but never write, sign-out included.
    expect(cookies).toContain("opentag_csrf=");

    for (const request of [
      { headers: { host: "localhost:8000" }, remoteAddress: "192.0.2.10" },
      { headers: { host: "example.com" }, remoteAddress: "127.0.0.1" },
    ]) {
      const rejected = await app.inject({ method: "GET", url: HTTP_PATHS.authDevCallback, ...request });
      expect(rejected.statusCode).toBe(404);
    }
    expect(betterAuth.paths).toEqual(["/api/v1/auth/dev/sign-in"]);
  });

  it("rejects an external development redirect before issuing credentials", async () => {
    const betterAuth = betterAuthStub(devSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, devSignIn: true });
    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=${encodeURIComponent("https://example.com")}`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(400);
    expect(betterAuth.paths).toEqual([]);
  });

  it("reports an unresolvable development user instead of redirecting to a signed-out page", async () => {
    const betterAuth = betterAuthStub(() => new Response(JSON.stringify({ message: "gone" }), { status: 503 }));
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, devSignIn: true });
    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=%2Fagents`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_DEV_USER_UNAVAILABLE" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("requires same-origin double-submit CSRF to sign out", async () => {
    /*
     * Better Auth's session cookie proves who the browser is, not that the request came from this origin's own pages.
     * Sign-out is a mutation like any other, so it carries the readable token too.
     */
    const betterAuth = betterAuthStub(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance });

    const rejected = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authBrowserLogout,
      headers: { cookie: "opentag_csrf=csrf" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(betterAuth.paths).toEqual([]);

    const accepted = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authBrowserLogout,
      headers: {
        cookie: "opentag_csrf=csrf",
        origin: "http://localhost:8000",
        "x-opentag-csrf": "csrf",
      },
    });
    expect(accepted.statusCode).toBe(204);
    expect(betterAuth.paths).toEqual(["/api/v1/auth/sign-out"]);
    // The double-submit token is OpenTag's, so Better Auth's sign-out cannot retire it.
    expect(String(accepted.headers["set-cookie"])).toContain("opentag_csrf=;");
  });
});

describe("the attempt budget", () => {
  it("refuses a caller that spends its budget within the window", () => {
    const limiter = new RouteRateLimiter(3, 60_000);

    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check("sign-in:member@example.com");

    expect(() => limiter.check("sign-in:member@example.com")).toThrow(/Too many/);
    // Bounded per key, so one address running out does not refuse a different one.
    expect(() => limiter.check("sign-in:other@example.com")).not.toThrow();
  });

  it("stays bounded against a key space the caller chooses", () => {
    const limiter = new RouteRateLimiter(20, 60_000, 50);

    for (let attempt = 0; attempt < 5_000; attempt += 1) limiter.check(`sign-in:attacker-${attempt}@example.com`);

    /*
     * An email address is attacker-supplied, so an unbounded map would be a way to spend the server's memory rather
     * than only its patience. Evicting a live counter can grant attempts, never deny them.
     */
    expect(limiter.size).toBeLessThanOrEqual(50);
  });
});

describe("email and password routes", () => {
  it("registers through Better Auth and hands back both halves of the browser credential", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "new@example.com", displayName: "New Account", password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(204);
    expect(betterAuth.paths).toEqual(["/api/v1/auth/sign-up/email"]);
    const cookies = String(response.headers["set-cookie"]);
    expect(cookies).toContain("opentag.session_token=password-session");
    // Without the double-submit token the new session could read and never write, including never sign itself out.
    expect(cookies).toContain("opentag_csrf=");
  });

  it("signs in through Better Auth and issues the double-submit token", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(204);
    expect(betterAuth.paths).toEqual(["/api/v1/auth/sign-in/email"]);
    expect(String(response.headers["set-cookie"])).toContain("opentag_csrf=");
  });

  it("lowercases the address before it reaches Better Auth, so casing cannot split an Account", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "  Member@Example.COM ", password: VALID_PASSWORD },
    });

    // Normalized before the lookup rather than after it, so a casing variant reaches the same Account.
    expect(betterAuth.bodies[0]).toMatchObject({ email: "member@example.com" });
  });

  it("forwards the display name as the field Better Auth maps onto the Account", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "named@example.com", displayName: "Named Account", password: VALID_PASSWORD },
    });

    // `name` is Better Auth's field for what OpenTag stores as `displayName`; sending the latter would drop it.
    expect(betterAuth.bodies[0]).toMatchObject({ name: "Named Account" });
  });

  it("answers a rejected sign-in the same way whether the address or the password was wrong", async () => {
    const betterAuth = betterAuthStub(
      () =>
        new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe("AUTH_INVALID_TOKEN");
    // Better Auth's own reason is deliberately not forwarded: it would say which addresses hold Accounts.
    expect(body.error.message).toBe("The email address or password is incorrect");
    expect(String(response.headers["set-cookie"] ?? "")).not.toContain("opentag_csrf=");
  });

  it("reports a server that could not answer as transient, not as a rejected credential", async () => {
    const betterAuth = betterAuthStub(
      () => new Response("upstream failure", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const signIn = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });
    const signUp = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "new@example.com", displayName: "New", password: VALID_PASSWORD },
    });

    /*
     * An outage reported as "wrong password" tells the person to retype a password that was right, tells the browser
     * not to retry, and hides the incident from whoever should see it.
     */
    expect(signIn.statusCode).toBe(503);
    expect(signIn.json().error.code).toBe("SERVICE_UNAVAILABLE");
    expect(signUp.statusCode).toBe(503);
    expect(signUp.json().error.code).toBe("SERVICE_UNAVAILABLE");
    // The library's own message can name internals, so it is restated rather than forwarded.
    expect(signIn.json().error.message).not.toContain("upstream failure");
  });

  it("reports Better Auth rate limiting as a typed rate-limit response", async () => {
    const betterAuth = betterAuthStub(() => new Response("slow down", { status: 429 }));
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({ code: "RATE_LIMITED", category: "rate_limit" });
  });

  it("preserves a suspension raised inside Better Auth rather than calling it a wrong password", async () => {
    const betterAuth = betterAuthStub(
      () =>
        new Response(JSON.stringify({ code: "AUTH_USER_SUSPENDED", message: "The Account is suspended" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "suspended@example.com", password: VALID_PASSWORD },
    });

    // Reaching this took a password the caller already had, so naming the reason discloses nothing they could not infer.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("AUTH_USER_SUSPENDED");
  });

  it("refuses a registration that is not a duplicate without claiming the address is taken", async () => {
    const betterAuth = betterAuthStub(
      () =>
        new Response(JSON.stringify({ code: "PASSWORD_TOO_SHORT", message: "Password too short" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "free@example.com", displayName: "Free", password: VALID_PASSWORD },
    });

    // Saying "already exists" here would send someone to recover an Account that does not exist.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("reports a taken address as a conflict, because registration cannot act on anything else", async () => {
    const betterAuth = betterAuthStub(
      () =>
        new Response(JSON.stringify({ code: "USER_ALREADY_EXISTS" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "taken@example.com", displayName: "Taken", password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AUTH_EMAIL_CONFLICT");
  });

  it("refuses a cross-site post before reaching Better Auth", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(betterAuth.paths).toEqual([]);
  });

  it("accepts a sign-in with no double-submit token, which is the one it is about to mint", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });

    // Requiring the token here would make a signed-out browser unable to sign in at all.
    expect(response.statusCode).toBe(204);
  });

  it("refuses a password shorter than the shared floor without asking Better Auth", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, passwordSignIn: true });

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "short@example.com", displayName: "Short", password: "short" },
    });

    expect(response.statusCode).toBe(400);
    expect(betterAuth.paths).toEqual([]);
  });

  it("reports the provider as disabled on a server that did not enable it", async () => {
    const betterAuth = betterAuthStub(passwordSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance });

    const signIn = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignIn,
      headers: SAME_ORIGIN,
      payload: { email: "member@example.com", password: VALID_PASSWORD },
    });
    const signUp = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authEmailSignUp,
      headers: SAME_ORIGIN,
      payload: { email: "new@example.com", displayName: "New", password: VALID_PASSWORD },
    });

    expect(signIn.statusCode).toBe(404);
    expect(signUp.statusCode).toBe(404);
    expect(signIn.json().error.code).toBe("AUTH_PROVIDER_DISABLED");
    // Refused by the route, so a disabled deployment never reaches the library at all.
    expect(betterAuth.paths).toEqual([]);
  });

  it("reports a provider response without an authorization URL as disabled", async () => {
    const betterAuth = betterAuthStub(() => new Response(JSON.stringify({}), { status: 200 }));
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, googleSignIn: true });
    const response = await app.inject({ method: "GET", url: HTTP_PATHS.authGoogleStart });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("AUTH_PROVIDER_DISABLED");
  });

  it("advertises the password provider without a start URL, because it is a form", async () => {
    const { app } = createBrowserApp({ passwordSignIn: true });

    const response = await app.inject({ method: "GET", url: HTTP_PATHS.authProviders });

    expect(response.json().providers).toContainEqual({ id: "password", enabled: true, startUrl: null });
  });
});
