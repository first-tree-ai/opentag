import { describe, expect, it } from "vitest";
import { mapProviderCliLocalStateToReadiness } from "../runtime/provider-cli/types.js";

describe("mapProviderCliLocalStateToReadiness", () => {
  it("maps every local state onto the coarse wire readiness vocabulary", () => {
    expect(mapProviderCliLocalStateToReadiness("ready")).toBe("ready");
    expect(mapProviderCliLocalStateToReadiness("absent")).toBe("install");
    expect(mapProviderCliLocalStateToReadiness("checking")).toBe("checking");
    expect(mapProviderCliLocalStateToReadiness("unavailable")).toBe("unavailable");
  });
});
