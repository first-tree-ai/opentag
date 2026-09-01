import { describe, expect, it } from "vitest";
import { compareSemVer, isSemVer, parseSemVer, SemVerStringSchema } from "../semver.js";

describe("SemVer parsing", () => {
  it("parses release, prerelease, and build coordinates", () => {
    expect(parseSemVer("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
    expect(parseSemVer("0.0.3-staging.1.1")).toEqual({
      major: 0,
      minor: 0,
      patch: 3,
      prerelease: ["staging", "1", "1"],
      build: [],
    });
    expect(parseSemVer("0.0.3-staging.1.1+build.7")).toEqual({
      major: 0,
      minor: 0,
      patch: 3,
      prerelease: ["staging", "1", "1"],
      build: ["build", "7"],
    });
  });

  it("rejects malformed versions", () => {
    for (const value of ["", "1", "1.2", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", "1.2.3+", " 1.2.3", "latest"]) {
      expect(parseSemVer(value), value).toBeUndefined();
      expect(isSemVer(value), value).toBe(false);
    }
    expect(SemVerStringSchema.safeParse("0.0.3-staging.1.1").success).toBe(true);
    expect(SemVerStringSchema.safeParse("0.0.3-01").success).toBe(false);
  });
});

describe("SemVer precedence", () => {
  it("orders core version numbers numerically", () => {
    expect(compareSemVer("0.0.2", "0.0.2")).toBe(0);
    expect(compareSemVer("0.0.10", "0.0.9")).toBe(1);
    expect(compareSemVer("0.1.0", "0.0.99")).toBe(1);
    expect(compareSemVer("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemVer("0.0.9", "0.0.10")).toBe(-1);
  });

  it("ranks a prerelease below its release", () => {
    expect(compareSemVer("0.0.3-staging.1.1", "0.0.3")).toBe(-1);
    expect(compareSemVer("0.0.3", "0.0.3-staging.1.1")).toBe(1);
    expect(compareSemVer("0.0.3-staging.1.1", "0.0.2")).toBe(1);
  });

  it("orders prerelease identifiers per SemVer section 11", () => {
    // Numeric identifiers compare numerically and rank below alphanumeric identifiers.
    expect(compareSemVer("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemVer("1.0.0-alpha", "1.0.0-1")).toBe(1);
    expect(compareSemVer("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareSemVer("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemVer("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareSemVer("0.0.3-staging.1.1", "0.0.3-staging.1.2")).toBe(-1);
    expect(compareSemVer("0.0.3-staging.1.1", "0.0.3-staging.1.1")).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(compareSemVer("0.0.3+build.1", "0.0.3+build.2")).toBe(0);
    expect(compareSemVer("0.0.3-staging.1.1+a", "0.0.3-staging.1.1")).toBe(0);
  });

  it("rejects invalid inputs explicitly", () => {
    expect(() => compareSemVer("not-a-version", "0.0.2")).toThrow("Not a valid SemVer");
    expect(() => compareSemVer("0.0.2", "0.0.2.1")).toThrow("Not a valid SemVer");
  });
});
