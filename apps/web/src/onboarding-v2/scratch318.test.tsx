import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingV2MockPage } from "./page.js";

function chooseOption(control: HTMLElement, optionName: string) {
  fireEvent.click(control);
  const option = screen.getByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

describe("scratch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reaches the computer step with an inventory", async () => {
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
    chooseOption(screen.getByLabelText("Computers on the account"), "One, online");
    console.log("LAB NOW", screen.getByLabelText("Computers on the account").textContent);
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));

    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    console.log("HEADINGS", screen.getAllByRole("heading").map((h) => h.textContent));
    console.log("BUTTONS", screen.getAllByRole("button").map((b) => b.textContent));
    console.log("OUTCOME", document.querySelector('[data-ui="onboarding-v2-check-outcome"]')?.textContent);
    expect(true).toBe(true);
  });
});
