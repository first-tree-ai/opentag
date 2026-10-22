import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStandaloneSetup, hasStandaloneSetup, rememberStandaloneSetup } from "./setup-layout.js";

describe("optional first-time setup layout hint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("recognizes only the Account that started setup and retires the hint on exit", () => {
    rememberStandaloneSetup("account-a");
    expect(hasStandaloneSetup("account-a")).toBe(true);
    expect(hasStandaloneSetup("account-b")).toBe(false);
    clearStandaloneSetup();
    expect(hasStandaloneSetup("account-a")).toBe(false);
  });

  it("tolerates unavailable browser storage without blocking navigation or sign-out", () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("Storage blocked", "SecurityError");
      });
    }
    expect(() => rememberStandaloneSetup("account-a")).not.toThrow();
    expect(hasStandaloneSetup("account-a")).toBe(false);
    expect(() => clearStandaloneSetup()).not.toThrow();
  });
});
