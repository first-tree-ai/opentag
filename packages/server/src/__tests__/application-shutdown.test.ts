import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { CloudBilling } from "../cloud-billing.js";
import { deferred } from "./support/deferred.js";

describe("application request work ownership", () => {
  it("preserves synchronous replies, callback hooks, this and original async results", async () => {
    const app = createApp();
    const seen: unknown[] = [];
    app.get(
      "/sync",
      {
        preHandler(_request, _reply, done) {
          seen.push(this);
          done();
        },
      },
      function (_request, reply) {
        seen.push(this);
        return reply.send("sync");
      },
    );
    app.get("/later", (_request, reply) => {
      setImmediate(() => reply.send("later"));
    });
    app.get("/async", async function () {
      seen.push(this);
      return "async";
    });
    app.get("/async-reply", async (_request, reply) => reply.send("async reply"));
    try {
      for (const [path, body] of [
        ["/sync", "sync"],
        ["/later", "later"],
        ["/async", "async"],
        ["/async-reply", "async reply"],
      ]) {
        expect((await app.inject({ url: path })).body).toBe(body);
      }
      expect(seen).toEqual([app, app, app]);
    } finally {
      await app.close();
    }
  });

  it("starts all child shutdown hooks after kickoff failure and still finalizes billing once", async () => {
    const events: string[] = [];
    const billing = {
      close: vi.fn(async () => {
        events.push("billing");
        throw new Error("Controlled billing close error");
      }),
    } as unknown as CloudBilling;
    const app = createApp({
      cloudBilling: billing,
      beginShutdown: () => {
        events.push("begin");
        throw new Error("Controlled producer stop error");
      },
      closeResources: () => {
        events.push("resources");
      },
    });
    await app.register(async (child) => {
      child.addHook("preClose", async () => {
        events.push("child stop");
      });
      child.addHook("onClose", async () => {
        events.push("child join");
      });
    });
    await app.ready();
    await expect(app.close()).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(["begin", "child stop", "child join", "billing", "resources"]);
    expect(billing.close).toHaveBeenCalledOnce();
  });

  it("does not await producer drain before child connection teardown", async () => {
    const connectionClosed = deferred();
    const events: string[] = [];
    const app = createApp({
      beginShutdown: async () => {
        events.push("begin");
        await connectionClosed.promise;
        events.push("joined");
      },
      closeResources: () => {
        events.push("resources");
      },
    });
    await app.register(async (child) => {
      child.addHook("preClose", async () => {
        events.push("connection close");
        connectionClosed.resolve();
      });
    });
    await app.ready();
    await app.close();
    expect(events).toEqual(["begin", "connection close", "joined", "resources"]);
  });
});

it("refuses a new HTTP phase as soon as the external shutdown signal is set", async () => {
  const shutdown = new AbortController();
  const handle = vi.fn(async () => "should not run");
  const app = createApp({ shutdownSignal: shutdown.signal });
  app.get("/late", handle);
  await app.ready();
  try {
    shutdown.abort();
    expect((await app.inject({ url: "/late" })).statusCode).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
