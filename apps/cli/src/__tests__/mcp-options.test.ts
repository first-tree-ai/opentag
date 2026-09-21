import { describe, expect, it } from "vitest";
import {
  authKindOf,
  collectOption,
  optionalList,
  optionalNumber,
  optionalString,
  resolveBearerKeySource,
  splitList,
  whenDefined,
  whenTrue,
} from "../commands/mcp/options.js";

describe("collectOption", () => {
  it("appends to the array Commander accumulated so far", () => {
    expect(collectOption("x-a=1", [])).toEqual(["x-a=1"]);
    expect(collectOption("x-b=2", ["x-a=1"])).toEqual(["x-a=1", "x-b=2"]);
  });
});

describe("optionalString", () => {
  it("maps an absent option to undefined and stringifies anything present", () => {
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString("")).toBe("");
    expect(optionalString("value")).toBe("value");
    expect(optionalString(7)).toBe("7");
  });
});

describe("optionalNumber", () => {
  it("maps an absent option to undefined and coerces anything present", () => {
    expect(optionalNumber(undefined)).toBeUndefined();
    expect(optionalNumber("7")).toBe(7);
    expect(optionalNumber(0)).toBe(0);
    expect(optionalNumber("not-a-number")).toBeNaN();
  });
});

describe("optionalList", () => {
  it("accepts only an array and treats anything else as absent", () => {
    expect(optionalList(["a", "b"])).toEqual(["a", "b"]);
    expect(optionalList([])).toEqual([]);
    expect(optionalList(undefined)).toBeUndefined();
    expect(optionalList("a,b")).toBeUndefined();
  });
});

describe("authKindOf", () => {
  it("accepts exactly the three auth kinds", () => {
    expect(authKindOf("oauth")).toBe("oauth");
    expect(authKindOf("bearer")).toBe("bearer");
    expect(authKindOf("none")).toBe("none");
  });

  it("rejects every other value, including the wrong case and an absent option", () => {
    for (const value of ["OAuth", "None", "basic", "", undefined, null, 3]) {
      expect(() => authKindOf(value)).toThrow("--default-auth must be oauth, bearer, or none");
    }
  });
});

describe("splitList", () => {
  it("splits on commas, trims, and drops empty entries", () => {
    expect(splitList("read, write")).toEqual(["read", "write"]);
    expect(splitList(" read , ,write, ")).toEqual(["read", "write"]);
    expect(splitList("")).toEqual([]);
    expect(splitList(" , , ")).toEqual([]);
  });
});

describe("resolveBearerKeySource", () => {
  it("honours an explicit anonymous declaration and refuses a key beside it", () => {
    expect(resolveBearerKeySource({ kind: "none" })).toEqual({ kind: "none" });
    expect(() => resolveBearerKeySource({ kind: "none", bearerKey: "" })).toThrow(
      "An anonymous authorization carries no key",
    );
    expect(() => resolveBearerKeySource({ kind: "none", bearerKeyStdin: true })).toThrow(
      "An anonymous authorization carries no key",
    );
  });

  it("never silently changes an OAuth request into a Bearer write", () => {
    expect(() => resolveBearerKeySource({ kind: "oauth" })).toThrow("use `mcp authorize`");
    expect(() => resolveBearerKeySource({ kind: "basic", bearerKey: "key" })).toThrow("--kind must be bearer or none");
  });

  it("prefers stdin, then the prompt, then the visible argument", () => {
    expect(resolveBearerKeySource({ bearerKeyStdin: true })).toEqual({ kind: "bearer", source: "stdin" });
    expect(resolveBearerKeySource({})).toEqual({ kind: "bearer", source: "prompt" });
    expect(resolveBearerKeySource({ kind: "bearer" })).toEqual({ kind: "bearer", source: "prompt" });
    expect(resolveBearerKeySource({ bearerKey: "key" })).toEqual({
      kind: "bearer",
      source: "argument",
      value: "key",
    });
    // A piped key wins over an argument, because the argument is the least safe of the two.
    expect(resolveBearerKeySource({ bearerKey: "key", bearerKeyStdin: true })).toEqual({
      kind: "bearer",
      source: "stdin",
    });
    expect(resolveBearerKeySource({ bearerKey: 7 })).toEqual({ kind: "bearer", source: "argument", value: "7" });
  });
});

describe("whenDefined / whenTrue", () => {
  it("omits the key entirely when the value is absent", () => {
    expect(whenDefined("url", undefined)).toEqual({});
    expect(whenDefined("url", "https://example.test")).toEqual({ url: "https://example.test" });
    expect(whenDefined("url", "")).toEqual({ url: "" });
  });

  it("spreads the flag only when it was set to true", () => {
    expect(whenTrue("clearUrl", true)).toEqual({ clearUrl: true });
    expect(whenTrue("clearUrl", undefined)).toEqual({});
    expect(whenTrue("clearUrl", false)).toEqual({});
    expect(whenTrue("clearUrl", "true")).toEqual({});
  });
});
