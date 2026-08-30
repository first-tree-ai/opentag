import { describe, expect, it } from "vitest";
import { isSupportedClientVersion, MINIMUM_SUPPORTED_CLIENT_VERSION } from "../client-version.js";

describe("minimum supported Client version", () => {
  it("pins the admitted release line at 0.0.2", () => {
    expect(MINIMUM_SUPPORTED_CLIENT_VERSION).toBe("0.0.2");
  });

  it("accepts the stable 0.0.2 floor and newer cores", () => {
    expect(isSupportedClientVersion("0.0.2")).toBe(true);
    expect(isSupportedClientVersion("0.0.2+build.7")).toBe(true);
    expect(isSupportedClientVersion("0.0.3-staging.1.0")).toBe(true);
    expect(isSupportedClientVersion("0.0.3-0.3.7")).toBe(true);
    expect(isSupportedClientVersion("0.0.3-x.7.z-92")).toBe(true);
    expect(isSupportedClientVersion("0.0.3+build.01")).toBe(true);
    expect(isSupportedClientVersion("0.0.3")).toBe(true);
    expect(isSupportedClientVersion("0.1.0")).toBe(true);
    expect(isSupportedClientVersion("1.0.0")).toBe(true);
  });

  it("rejects the previous public CLI, prereleases below the floor, and malformed values", () => {
    expect(isSupportedClientVersion("0.0.1")).toBe(false);
    expect(isSupportedClientVersion("0.0.1-staging.1.0")).toBe(false);
    expect(isSupportedClientVersion("0.0.2-staging.1.0")).toBe(false);
    expect(isSupportedClientVersion("0.0.0")).toBe(false);
    expect(isSupportedClientVersion("")).toBe(false);
    expect(isSupportedClientVersion("latest")).toBe(false);
    expect(isSupportedClientVersion("v0.0.2")).toBe(false);
    expect(isSupportedClientVersion("0.0.2.1")).toBe(false);
    expect(isSupportedClientVersion("00.0.2")).toBe(false);
    expect(isSupportedClientVersion("0.0.02")).toBe(false);
    expect(isSupportedClientVersion(" 0.0.2")).toBe(false);
    expect(isSupportedClientVersion("0.0.2 ")).toBe(false);
  });

  it("rejects invalid prerelease and build identifier structure", () => {
    for (const version of [
      "0.0.3-alpha..1",
      "0.0.3-01",
      "1.0.0-.",
      "1.0.0-alpha.",
      "1.0.0+build..7",
      "1.0.0+.",
      "1.0.0+build_7",
    ]) {
      expect(isSupportedClientVersion(version), version).toBe(false);
    }
  });
});
