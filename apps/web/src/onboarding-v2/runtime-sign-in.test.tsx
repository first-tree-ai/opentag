import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeSignIn, runtimeSignInCommands } from "./runtime-sign-in.js";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("RuntimeSignIn", () => {
  it("opens the Claude Code terminal steps with the commands inline", () => {
    render(<RuntimeSignIn computerName="Ada's Mac" provider="claude-code" />);

    const toggle = screen.getByRole("button", { name: "Sign in" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(toggle);

    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      "Open a terminal on Ada's Mac.",
      "Run claude",
      "Enter /login and follow the prompts to sign in.",
    ]);
    expect(screen.getByText("/login").tagName).toBe("CODE");
    // Commands this short are typed, not copied, so the steps carry no copy controls.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("uses codex login for Codex", () => {
    render(<RuntimeSignIn computerName="Ada's Mac" provider="codex" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("codex login")).toBeTruthy();
    expect(screen.queryByText("/login")).toBeNull();
  });

  it("starts open when reached from the Agent list's Sign in link", () => {
    window.history.replaceState({}, "", "/agents/setup?agentId=a#sign-in");
    render(<RuntimeSignIn computerName="Ada's Mac" provider="codex" />);
    expect(screen.getByRole("button", { name: "Sign in" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list")).toBeTruthy();
  });

  it("offers nothing for a runtime without terminal sign-in", () => {
    expect(runtimeSignInCommands("pi")).toBeUndefined();
    const { container } = render(<RuntimeSignIn computerName="Ada's Mac" provider="pi" />);
    expect(container.textContent).toBe("");
  });
});
