import { describe, expect, it } from "vitest";
import { ServerHealthSchema } from "../health.js";

describe("ServerHealthSchema", () => {
  it("accepts the OpenTag server health response", () => {
    expect(
      ServerHealthSchema.parse({
        status: "ok",
        service: "opentag-server",
        runtimeOwnership: {
          mode: "single",
          status: "owned",
          instanceId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).toEqual({
      status: "ok",
      service: "opentag-server",
      runtimeOwnership: {
        mode: "single",
        status: "owned",
        instanceId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it.each([
    { status: "degraded", service: "opentag-server" },
    { status: "ok", service: "another-service" },
    { status: "ok" },
    { status: "ok", service: "opentag-server", unexpected: true },
    { status: "ok", service: "opentag-server", runtimeOwnership: { mode: "multi", status: "owned" } },
  ])("rejects an invalid response: %o", (value) => {
    expect(ServerHealthSchema.safeParse(value).success).toBe(false);
  });
});
