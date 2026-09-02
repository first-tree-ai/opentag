import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { BootstrapReadiness } from "../bootstrap-readiness.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /readyz", () => {
  it("reports explicit bootstrap stages instead of liveness", async () => {
    const readiness = new BootstrapReadiness();
    const app = createApp({ readiness });
    apps.push(app);

    const unavailable = await app.inject({ method: "GET", url: "/readyz" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ ready: false, completedStages: [], status: "not_ready" });

    for (const stage of ["configuration", "migration", "application", "listen"] as const) {
      readiness.complete(stage);
    }
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });
});

describe("GET /healthz", () => {
  it("returns the shared health contract", async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "opentag-server",
    });
  });

  it("probes the configured database before reporting healthy", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const app = createApp({ database: { execute } as never });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "opentag-server" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses the application TaskService database when no explicit probe client is supplied", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const app = createApp({ taskService: { database: { execute } } as never });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when the database health probe fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("database connection refused"));
    const app = createApp({ database: { execute } as never });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unhealthy", service: "opentag-server" });
    expect(response.body).not.toContain("database connection refused");
  });
});
