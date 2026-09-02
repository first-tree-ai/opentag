import { describe, expect, it } from "vitest";
import { formatRemaining } from "./checks.js";

describe("formatRemaining", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatRemaining(15 * 60 * 1_000)).toBe("15:00");
    expect(formatRemaining(65_000)).toBe("1:05");
  });

  it("never renders a negative duration", () => {
    expect(formatRemaining(-1_000)).toBe("0:00");
  });
});
