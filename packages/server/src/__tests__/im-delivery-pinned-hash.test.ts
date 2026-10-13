import type { DirectImMessageDeliveryRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const hashes = vi.hoisted(() => ({
  current: vi.fn<(request: unknown) => string>(),
  legacy: vi.fn<(request: unknown, layout: string) => string>(),
}));

vi.mock("@opentag/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opentag/shared")>()),
  computeDirectInputHash: hashes.current,
  computeLegacyDirectInputHash: hashes.legacy,
}));

const { matchPinnedDirectInputHash } = await import("../runtime/im-delivery-pinned-hash.js");

const request = {} as DirectImMessageDeliveryRequest;

afterEach(() => {
  hashes.current.mockReset();
  hashes.legacy.mockReset();
});

describe("pinned direct input hash matching", () => {
  it("accepts the current layout without consulting historical layouts", () => {
    hashes.current.mockReturnValue("expected");
    expect(matchPinnedDirectInputHash(request, "expected")).toBe("expected");
    expect(hashes.legacy).not.toHaveBeenCalled();
  });

  it("tries each frozen layout in order and stops at the first match", () => {
    hashes.current.mockReturnValue("current");
    hashes.legacy.mockImplementation((_request, layout) => (layout === "0.1.0" ? "expected" : "other"));
    expect(matchPinnedDirectInputHash(request, "expected")).toBe("expected");
    expect(hashes.legacy.mock.calls.map(([, layout]) => layout)).toEqual(["0.1.0"]);
  });

  it("treats a layout that cannot represent the request as a non-match", () => {
    hashes.current.mockReturnValue("current");
    hashes.legacy.mockImplementation((_request, layout) => {
      if (layout === "0.1.0") throw new Error("not representable");
      return "expected";
    });
    expect(matchPinnedDirectInputHash(request, "expected")).toBe("expected");
    expect(hashes.legacy.mock.calls.map(([, layout]) => layout)).toEqual(["0.1.0", "self-configuration"]);
  });

  it("rejects a payload that no layout reproduces, including a missing pinned hash", () => {
    hashes.current.mockReturnValue("current");
    hashes.legacy.mockReturnValue("legacy");
    expect(matchPinnedDirectInputHash(request, "expected")).toBeUndefined();
    expect(matchPinnedDirectInputHash(request, null)).toBeUndefined();
  });
});
