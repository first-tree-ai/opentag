import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overwriteGetLocale } from "../paraglide/runtime.js";
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

  it("enables Back on the second step, then locks both navigation actions while creating", () => {
    const onBack = vi.fn();
    const onSubmit = vi.fn();
    const readyDraft: AgentDraft = { destination: "local", name: "opentag", runtime: "codex" };
    const { rerender } = render(
      <AgentStep
        draft={readyDraft}
        onBack={onBack}
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitLabel="Create Agent"
      />,
    );

    const back = screen.getByRole("button", { name: "Back" });
    const create = screen.getByRole("button", { name: "Create Agent" });
    expect(back.hasAttribute("disabled")).toBe(false);
    expect(create.hasAttribute("disabled")).toBe(false);

    rerender(
      <AgentStep
        draft={readyDraft}
        onBack={onBack}
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitLabel="Creating agent…"
        submitting
      />,
    );
    expect(back.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Creating agent…" }).hasAttribute("disabled")).toBe(true);
  });

  describe("Agent name characters", () => {
    afterEach(() => overwriteGetLocale(() => "en"));

    function renderName(name: string) {
      render(
        <AgentStep
          draft={{ destination: "local", name, runtime: "codex" }}
          onBack={() => undefined}
          onChange={() => undefined}
          onSubmit={() => undefined}
          submitLabel="Create Agent"
        />,
      );
      const input = screen.getByRole("textbox");
      fireEvent.blur(input);
      const description = (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      return { description, input };
    }

    it.each([
      ["en", "Letters, numbers, Chinese characters and hyphens, not starting with a hyphen."],
      ["zh", "支持字母（含大写）、数字、中文和连字符，不能以连字符开头。"],
    ] as const)("accepts uppercase and Chinese names under the %s hint", (locale, hint) => {
      overwriteGetLocale(() => locale);
      const { description, input } = renderName("代码Reviewer-2");
      expect(description).toContain(hint);
      expect(input.getAttribute("aria-invalid")).toBeNull();
    });

    it.each([
      ["en", "Contains an unsupported character or starts with a hyphen."],
      ["zh", "含有不支持的字符，或以连字符开头。"],
    ] as const)("gives a short %s error for an unsupported character", (locale, error) => {
      overwriteGetLocale(() => locale);
      const { description, input } = renderName("代码_审查");
      expect(description).toContain(error);
      expect(input.getAttribute("aria-invalid")).toBe("true");
    });
  });

  it("keeps Create Agent disabled until a Runtime is selected", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "opentag", runtime: undefined }}
        onBack={() => undefined}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );

    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
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
        onBack={() => undefined}
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
