import { describe, expect, it } from "vitest";
import { ServerDeepHealthSchema, ServerHealthSchema } from "../health.js";

describe("ServerDeepHealthSchema", () => {
  it.each([
    { status: "ok", service: "opentag-server", checks: { database: "ok" } },
    { status: "ok", service: "opentag-server", checks: { database: "unconfigured" } },
    { status: "degraded", service: "opentag-server", checks: { database: "fail" } },
  ])("accepts a deep health response: %o", (value) => {
    expect(ServerDeepHealthSchema.parse(value)).toEqual(value);
  });

  it.each([
    { status: "ok", service: "opentag-server" },
    { status: "ok", service: "opentag-server", checks: { database: "down" } },
    { status: "ok", service: "opentag-server", checks: { database: "ok", cache: "ok" } },
    { status: "ok", service: "opentag-server", checks: { database: "ok" }, unexpected: true },
    { status: "ok", service: "opentag-server", checks: { database: "fail" } },
    { status: "degraded", service: "opentag-server", checks: { database: "ok" } },
    { status: "degraded", service: "opentag-server", checks: { database: "unconfigured" } },
  ])("rejects an invalid deep response: %o", (value) => {
    expect(ServerDeepHealthSchema.safeParse(value).success).toBe(false);
  });
});

describe("ServerHealthSchema", () => {
  it("accepts the OpenTag server health response", () => {
    expect(
      ServerHealthSchema.parse({
        status: "ok",
        service: "opentag-server",
      }),
    ).toEqual({ status: "ok", service: "opentag-server" });
  });

  it.each([
    { status: "degraded", service: "opentag-server" },
    { status: "ok", service: "another-service" },
    { status: "ok" },
    { status: "ok", service: "opentag-server", unexpected: true },
  ])("rejects an invalid response: %o", (value) => {
    expect(ServerHealthSchema.safeParse(value).success).toBe(false);
  });
});
