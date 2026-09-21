import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark.js";

describe("BrandMark", () => {
  it("renders the Pi mark rather than the label initial", () => {
    const { container } = render(<BrandMark brand="pi" label="Pi" />);

    expect(container.querySelector('[data-brand="pi"] img')).not.toBeNull();
    expect(container.querySelector('[data-brand="pi"]')?.textContent).toBe("");
  });
});
