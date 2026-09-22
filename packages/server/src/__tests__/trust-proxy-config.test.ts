import { describe, expect, it } from "vitest";
import { TrustProxySchema } from "../trust-proxy-config.js";

describe("TrustProxySchema", () => {
  it("defaults to trusting no proxy", () => {
    expect(TrustProxySchema.parse(undefined)).toBe(false);
    expect(TrustProxySchema.parse("  ")).toBe(false);
    expect(TrustProxySchema.parse("false")).toBe(false);
    expect(TrustProxySchema.parse("TRUE")).toBe(true);
  });

  it("accepts addresses, CIDR ranges, and proxy-addr presets", () => {
    expect(TrustProxySchema.parse(" uniquelocal, 127.0.0.1 ,10.0.0.0/8,fc00::/7,::1 ")).toEqual([
      "uniquelocal",
      "127.0.0.1",
      "10.0.0.0/8",
      "fc00::/7",
      "::1",
    ]);
  });

  it("rejects hop counts and malformed entries, naming them", () => {
    for (const value of ["1", "10.0.0.0/33", "fc00::/129", "10.0.0.0/8/1", "proxy.example", "10.0.0.0/x", ","]) {
      expect(TrustProxySchema.safeParse(value).success, value).toBe(false);
    }
    const result = TrustProxySchema.safeParse("127.0.0.1,nginx");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("invalid: nginx");
  });
});
