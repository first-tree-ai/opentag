import { describe, expect, it } from "vitest";
import { getChannelConfig, ServiceIdSchema } from "../channel.js";

describe("channel configuration", () => {
  it("derives all local identities from the channel", () => {
    expect(getChannelConfig("dev", "/home/test")).toMatchObject({
      binName: "opentag-dev",
      defaultHome: "/home/test/.opentag-dev",
      packageName: "open-tag",
      serviceId: "opentag-dev",
    });
    expect(getChannelConfig("staging", "/home/test")).toMatchObject({
      binName: "opentag-staging",
      defaultHome: "/home/test/.opentag-staging",
      packageName: "open-tag-staging",
      serviceId: "opentag-staging",
    });
    expect(getChannelConfig("prod", "/home/test")).toMatchObject({
      binName: "opentag",
      defaultHome: "/home/test/.opentag",
      packageName: "open-tag",
      serviceId: "opentag",
    });
  });

  it("accepts only canonical service identifiers", () => {
    expect(ServiceIdSchema.parse("opentag")).toBe("opentag");
    expect(ServiceIdSchema.parse("opentag-staging")).toBe("opentag-staging");
    for (const value of ["OpenTag", "opentag_qa", "opentag.service", "-opentag", "opentag-"]) {
      expect(ServiceIdSchema.safeParse(value).success).toBe(false);
    }
  });
});
