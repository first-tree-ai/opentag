import { describe, expect, it } from "vitest";
import { resolveWebVersion } from "./web-version.js";

describe("resolveWebVersion", () => {
  it("prefers the build-time release identity and falls back to the manifest version", () => {
    expect(resolveWebVersion({ OPENTAG_WEB_VERSION: " 3f1c2a9 " }, "0.0.0")).toBe("3f1c2a9");
    expect(resolveWebVersion({ OPENTAG_WEB_VERSION: "" }, "0.0.0")).toBe("0.0.0");
    expect(resolveWebVersion({}, "0.0.0")).toBe("0.0.0");
  });

  it("is what the bundle define carries", () => {
    expect(typeof __OPENTAG_WEB_VERSION__).toBe("string");
    expect(__OPENTAG_WEB_VERSION__.length).toBeGreaterThan(0);
  });
});
