import { describe, expect, it } from "vitest";
import { ServerHealthSchema } from "../health.js";

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
