import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { createBetterAuth } from "../../auth/better-auth.js";
import { createDatabaseClient } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const ORIGIN = "http://localhost:8000";
let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => pg?.stop());

async function fixture(initial: "headers" | "body" | "healthy") {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1, statementTimeoutMs: 1000, queryTimeoutMs: 2000 });
  const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const entered = deferred();
  const release = deferred();
  const subject = randomUUID();
  const claims = {
    sub: subject,
    email: `${subject}@example.test`,
    email_verified: true,
    name: "Native Google",
    iss: "https://accounts.google.com",
    aud: "fixture",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };
  const jwt = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
  const tokens = { access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3600, id_token: jwt };
  let mode = initial;
  let exchanges = 0;
  let transportClosed = false;
  const signals: (AbortSignal | null | undefined)[] = [];
  const upstream = createServer((_request, response) => {
    exchanges++;
    const observedMode = mode;
    if (observedMode === "healthy") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(tokens));
      return;
    }
    response.once("close", () => {
      transportClosed = true;
    });
    if (observedMode === "body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"access_token":"fixture-access-token"');
    }
    entered.resolve();
    void release.promise.then(() => {
      if (response.destroyed) return;
      if (observedMode === "headers") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(tokens));
      } else response.end(`, "token_type":"Bearer", "expires_in":3600, "id_token":${JSON.stringify(jwt)}}`);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No token fixture address");
  const actualFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", ((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://oauth2.googleapis.com/token")
      throw new Error(`Unexpected provider request: ${new URL(url).origin}`);
    signals.push(init?.signal);
    return actualFetch(`http://127.0.0.1:${address.port}/token`, init);
  }) satisfies typeof fetch);
  const auth = createBetterAuth(client.database, {
    publicUrl: ORIGIN,
    secret: "fixture-google-native-budget-secret-at-least-32-characters",
    secureCookies: false,
    sessionTtlSeconds: 3600,
    google: { clientId: "fixture", clientSecret: "fixture-client-secret" },
  });
  const app = createApp({
    betterAuth: { instance: auth, publicUrl: ORIGIN },
    browserAuth: { publicOrigin: ORIGIN, secureCookies: false, sessionTtlSeconds: 3600, googleSignIn: true },
  });
  const start = async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(response.statusCode).toBe(302);
    const state = new URL(response.headers.location as string).searchParams.get("state");
    if (!state) throw new Error("No official OAuth state");
    const cookie = ([] as string[])
      .concat(response.headers["set-cookie"] as string | string[])
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    return { state, cookie };
  };
  const callback = async (flow: Awaited<ReturnType<typeof start>>, code: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/auth/callback/google?state=${encodeURIComponent(flow.state)}&code=${code}`,
      headers: { cookie: flow.cookie },
    });
  const counts = async () => {
    const [row] =
      await observer.sql`select (select count(*)::int from users) as users, (select count(*)::int from auth_identities) as identities, (select count(*)::int from auth_sessions) as sessions`;
    return row;
  };
  return {
    app,
    auth,
    client,
    observer,
    entered,
    release,
    signals,
    start,
    callback,
    counts,
    exchanges: () => exchanges,
    transportClosed: () => transportClosed,
    healthy: () => {
      mode = "healthy";
    },
    async close() {
      release.resolve();
      await app.close();
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
      await Promise.all([client.sql.end({ timeout: 1 }), observer.sql.end({ timeout: 1 })]);
    },
  };
}

it.each(["headers", "body"] as const)(
  "bounds official Google exchange %s with a native deadline and permits a new flow",
  async (phase) => {
    const f = await fixture(phase);
    const flow = await f.start();
    const startedAt = performance.now();
    const callback = f.callback(flow, "uncertain-code");
    try {
      await Promise.race([
        f.entered.promise,
        callback.then((response) => {
          throw new Error(
            `Exchange ended before the transport gate: ${response.statusCode} ${response.headers.location}`,
          );
        }),
      ]);
      expect(f.signals[0]).toBeInstanceOf(AbortSignal);
      expect(await f.client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
      const [idle] = await f.observer
        .sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`;
      expect(idle?.count).toBe(0);
      const response = await callback;
      expect(performance.now() - startedAt).toBeLessThan(14000);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain("error=");
      expect(f.signals[0]?.aborted).toBe(true);
      await vi.waitFor(() => expect(f.transportClosed()).toBe(true));
      expect(f.exchanges()).toBe(1);
      expect(await f.counts()).toMatchObject({ users: 0, identities: 0, sessions: 0 });
      f.healthy();
      const next = await f.start();
      const recovered = await f.callback(next, "new-code");
      expect(recovered.statusCode).toBe(302);
      expect(recovered.headers.location).not.toContain("error=");
      expect(f.exchanges()).toBe(2);
      expect(await f.counts()).toMatchObject({ users: 1, identities: 1, sessions: 1 });
    } finally {
      f.release.resolve();
      await callback;
      await f.close();
    }
  },
  20000,
);

it("keeps a fully parsed Google token's transaction owned after client loss and shutdown", async () => {
  const f = await fixture("healthy");
  const flow = await f.start();
  const entered = deferred();
  const release = deferred();
  const transaction = f.client.database.transaction.bind(f.client.database);
  const spy = vi.spyOn(f.client.database, "transaction").mockImplementation(((work, options) =>
    transaction(async (tx) => {
      const wrapped = new Proxy(tx, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "insert") return typeof value === "function" ? value.bind(target) : value;
          return (table: unknown) => {
            const builder = Reflect.apply(value, target, [table]) as ReturnType<typeof tx.insert>;
            if (table !== users) return builder;
            const values = builder.values.bind(builder);
            builder.values = ((...args: Parameters<typeof values>) => {
              const query = values(...args);
              const then = query.then.bind(query);
              // biome-ignore lint/suspicious/noThenProperty: Hold the real official Account insert inside its existing transaction.
              Object.defineProperty(query, "then", {
                configurable: true,
                value: (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
                  then(async (rows: unknown) => {
                    entered.resolve();
                    await release.promise;
                    return rows;
                  }).then(resolve, reject),
              });
              return query;
            }) as typeof builder.values;
            return builder;
          };
        },
      });
      return work(wrapped);
    }, options)) as typeof f.client.database.transaction);
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
  // The provider override is deliberately narrow; this client uses Node's native HTTP transport.
  const { request } = await import("node:http");
  const peer = request(
    `${origin}/api/v1/auth/callback/google?state=${encodeURIComponent(flow.state)}&code=confirmed-code`,
    { headers: { cookie: flow.cookie } },
  );
  const completed = new Promise<unknown>((resolve) => {
    peer.on("error", resolve);
    peer.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode, location: response.headers.location });
    });
  });
  peer.end();
  let closing: Promise<void> | undefined;
  let closed = false;
  try {
    await Promise.race([
      entered.promise,
      completed.then((result) => {
        throw new Error(`Callback ended before its official write: ${JSON.stringify(result)}`);
      }),
    ]);
    const disconnected = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    peer.destroy();
    await disconnected;
    closing = f.app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect(f.exchanges()).toBe(1);
    expect(await f.counts()).toMatchObject({ users: 1, identities: 1, sessions: 1 });
  } finally {
    release.resolve();
    peer.destroy();
    await closing;
    spy.mockRestore();
    await f.close();
  }
}, 20000);
