import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { BootstrapReadiness } from "../bootstrap-readiness.js";

const apps: ReturnType<typeof createApp>[] = [];

function completeReadiness(readiness: BootstrapReadiness): void {
  for (const stage of ["configuration", "migration", "application", "listen"] as const) {
    readiness.complete(stage);
  }
}

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
    expect(ready.json()).toEqual({ status: "ready", runtimeOwnership: { mode: "single", status: "not_owned" } });
  });
});

describe("GET /healthz", () => {
  it("returns the shared liveness contract without probing the database", async () => {
    const execute = vi.fn();
    const app = createApp({ database: { execute } as never });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "opentag-server",
      runtimeOwnership: { mode: "single", status: "not_owned" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports the instance that owns the runtime lease", async () => {
    const app = createApp({
      runtimeOwnership: {
        mode: "single",
        status: "owned",
        instanceId: "11111111-1111-4111-8111-111111111111",
      },
    });
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toMatchObject({
      runtimeOwnership: {
        mode: "single",
        status: "owned",
        instanceId: "11111111-1111-4111-8111-111111111111",
      },
    });
    const readiness = await app.inject({ method: "GET", url: "/readyz" });
    expect(readiness.json()).toMatchObject({ runtimeOwnership: health.json().runtimeOwnership });
  });

  it("probes the configured database before reporting ready", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ database: { execute } as never, readiness });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", runtimeOwnership: { mode: "single", status: "not_owned" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses the application TaskService database when no explicit readiness client is supplied", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ readiness, taskService: { database: { execute } } as never });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns not ready when the database readiness probe fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("database connection refused"));
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ database: { execute } as never, readiness });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready", ready: true });
    expect(response.body).not.toContain("database connection refused");
  });

  it("abandons a never-settling database probe at the server deadline", async () => {
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ database: { execute } as never, readiness });
    apps.push(app);

    const startedAt = performance.now();
    const response = await app.inject({ method: "GET", url: "/readyz" });
    const elapsedMs = performance.now() - startedAt;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready", ready: true });
    expect(elapsedMs).toBeLessThan(2_000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("recovers after an abandoned probe ages out without fanning out probes", async () => {
    vi.useFakeTimers({ now: 0 });
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const firstProbe = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(() => firstProbe)
      .mockResolvedValueOnce([]);
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ database: { execute } as never, readiness });
    apps.push(app);

    try {
      const firstRequest = app.inject({ method: "GET", url: "/readyz" });
      await vi.advanceTimersByTimeAsync(1_000);
      const firstResponse = await firstRequest;
      expect(firstResponse.statusCode).toBe(503);
      expect(execute).toHaveBeenCalledTimes(1);

      const inWindowRequests = Promise.all([
        app.inject({ method: "GET", url: "/readyz" }),
        app.inject({ method: "GET", url: "/readyz" }),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      const inWindowResponses = await inWindowRequests;
      expect(inWindowResponses.every((response) => response.statusCode === 503)).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8_001);
      const recovered = await app.inject({ method: "GET", url: "/readyz" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual({
        status: "ready",
        runtimeOwnership: { mode: "single", status: "not_owned" },
      });
      expect(execute).toHaveBeenCalledTimes(2);

      rejectFirst?.(new Error("late probe rejection"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins live probes across three aged-out windows", async () => {
    vi.useFakeTimers({ now: 0 });
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ database: { execute } as never, readiness });
    apps.push(app);

    try {
      const firstRequest = app.inject({ method: "GET", url: "/readyz" });
      await vi.advanceTimersByTimeAsync(1_000);
      const firstResponse = await firstRequest;

      await vi.advanceTimersByTimeAsync(9_001);
      const secondRequest = app.inject({ method: "GET", url: "/readyz" });
      await vi.advanceTimersByTimeAsync(1_000);
      const secondResponse = await secondRequest;

      await vi.advanceTimersByTimeAsync(9_001);
      const thirdResponse = await app.inject({ method: "GET", url: "/readyz" });

      expect([firstResponse, secondResponse, thirdResponse].every((response) => response.statusCode === 503)).toBe(
        true,
      );
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees a live-attempt slot when a replacement probe settles", async () => {
    vi.useFakeTimers({ now: 0 });
    const firstProbe = new Promise<never>(() => undefined);
    const execute = vi
      .fn()
      .mockImplementationOnce(() => firstProbe)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const readiness = new BootstrapReadiness();
    completeReadiness(readiness);
    const app = createApp({ database: { execute } as never, readiness });
    apps.push(app);

    try {
      const firstRequest = app.inject({ method: "GET", url: "/readyz" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await firstRequest).statusCode).toBe(503);

      await vi.advanceTimersByTimeAsync(9_001);
      const recovered = await app.inject({ method: "GET", url: "/readyz" });
      expect(recovered.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10_001);
      const nextProbe = await app.inject({ method: "GET", url: "/readyz" });
      expect(nextProbe.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
