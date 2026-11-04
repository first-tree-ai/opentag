import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentDraft } from "./flow.js";
import { AgentStep, DestinationStep } from "./steps.js";

const baseDraft: AgentDraft = { destination: undefined, name: "opentag", runtime: undefined };

describe("creation step navigation", () => {
  it("shows only Continue on the first step and enables it after a destination is selected", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <DestinationStep cloud={{ kind: "loading" }} draft={baseDraft} onChoose={() => undefined} onSubmit={onSubmit} />,
    );

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(true);

    rerender(
      <DestinationStep
        cloud={{ kind: "ready", available: false, reason: "disabled" }}
        draft={{ ...baseDraft, destination: "local" }}
        onChoose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    expect(continueButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(continueButton);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("offers no in-flow Back on the second step and locks Create while creating", () => {
    const onSubmit = vi.fn();
    const readyDraft: AgentDraft = { destination: "local", name: "opentag", runtime: "codex" };
    const { rerender } = render(
      <AgentStep draft={readyDraft} onChange={() => undefined} onSubmit={onSubmit} submitLabel="Create Agent" />,
    );

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const create = screen.getByRole("button", { name: "Create Agent" });
    expect(create.hasAttribute("disabled")).toBe(false);

    rerender(
      <AgentStep
        draft={readyDraft}
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitLabel="Creating agent…"
        submitting
      />,
    );
    expect(screen.getByRole("button", { name: "Creating agent…" }).hasAttribute("disabled")).toBe(true);
  });

  it("names the runtime choice an Agent and never says Runtime", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "opentag", runtime: undefined }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );

    expect(screen.getByRole("group", { name: "Agent to use" })).toBeTruthy();
    expect(screen.queryByText(/coming soon/)).toBeNull();
    expect(screen.getByText("Works with many model providers")).toBeTruthy();
    expect(screen.queryByText(/runtime/i)).toBeNull();
  });

  it("states the allowed name characters before anything is typed", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "", runtime: undefined }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );

    const rule = "Use Chinese characters, letters, numbers, and hyphens (-); don't start with a hyphen.";
    expect(screen.getByText(rule)).toBeTruthy();
    const input = screen.getByLabelText("Agent name");
    const describedBy = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain(rule);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("placeholder")).toBe("opentag");
  });

  it("names a refused name briefly instead of repeating the character rule", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "研发助理!", runtime: "codex" }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );

    const input = screen.getByLabelText("Agent name");
    fireEvent.blur(input);

    const rule = "Use Chinese characters, letters, numbers, and hyphens (-); don't start with a hyphen.";
    expect(screen.getByText("The name has characters that aren't allowed.")).toBeTruthy();
    expect(screen.getAllByText(rule)).toHaveLength(1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("says a name is too long while typing, before blur or Create", () => {
    const tooLong = "中".repeat(22);
    const { rerender } = render(
      <AgentStep
        draft={{ destination: "local", name: "中".repeat(21), runtime: "codex" }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );
    const error = "The name is too long: up to 64 letters or 21 Chinese characters.";
    expect(screen.queryByText(error)).toBeNull();

    rerender(
      <AgentStep
        draft={{ destination: "local", name: tooLong, runtime: "codex" }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );
    expect(screen.getByText(error)).toBeTruthy();
    expect(screen.getByLabelText("Agent name").getAttribute("aria-invalid")).toBe("true");
  });

  it("waits for blur before flagging other name problems", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "", runtime: "codex" }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );
    expect(screen.getByLabelText("Agent name").getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps Create Agent disabled until a Runtime is selected", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "opentag", runtime: undefined }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );

    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("enables the Cloud destination only once the service answers available", () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <DestinationStep cloud={{ kind: "loading" }} draft={baseDraft} onChoose={onChoose} onSubmit={() => undefined} />,
    );
    // No answer yet: the Cloud choice is disabled rather than guessed, and says it is checking.
    expect(screen.getByRole("button", { name: /Cloud computer/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Checking…")).toBeTruthy();

    rerender(
      <DestinationStep
        cloud={{ kind: "ready", available: true, reason: null }}
        draft={baseDraft}
        onChoose={onChoose}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Cloud computer/ }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Cloud computer/ }));
    expect(onChoose).toHaveBeenCalledWith("cloud");

    rerender(
      <DestinationStep
        cloud={{ kind: "ready", available: false, reason: "execution_unavailable" }}
        draft={baseDraft}
        onChoose={onChoose}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Cloud computer/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("says the availability check failed — never that the deployment lacks Cloud — and retries on request", () => {
    const onCloudRetry = vi.fn();
    render(
      <DestinationStep
        cloud={{ kind: "failed" }}
        draft={baseDraft}
        onChoose={() => undefined}
        onCloudRetry={onCloudRetry}
        onSubmit={() => undefined}
      />,
    );

    // The failed read keeps Cloud disabled, and the copy reports the check, not a deployment fact.
    expect(screen.getByRole("button", { name: /Cloud computer/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Could not check")).toBeTruthy();
    expect(
      screen.getByText("Cloud availability could not be checked. Try again, or run the agent on your own computer."),
    ).toBeTruthy();
    expect(screen.queryByText("Temporarily unavailable")).toBeNull();
    // Local is untouched by the failed Cloud read.
    expect(screen.getByRole("button", { name: /Local computer/ }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onCloudRetry).toHaveBeenCalledOnce();
  });

  it("fixes the runtime for a Cloud destination and needs no selection to submit", () => {
    const onSubmit = vi.fn();
    render(
      <AgentStep
        draft={{ destination: "cloud", name: "opentag", runtime: undefined }}
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitLabel="Create Agent"
      />,
    );

    // Cloud creation requires no runtime choice or runtime details.
    expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByText("Pi")).toBeNull();
    const create = screen.getByRole("button", { name: "Create Agent" });
    expect(create.hasAttribute("disabled")).toBe(false);
    fireEvent.click(create);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
