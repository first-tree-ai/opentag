import { describe, expect, it } from "vitest";
import { getChannelConfig } from "../channel.js";

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
});
