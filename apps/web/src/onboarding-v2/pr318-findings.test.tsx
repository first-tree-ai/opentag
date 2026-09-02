/**
 * Probe for the reviews of `40e082c` and `8df0d51`, and for the product rule this step now follows:
 * an Account has one Computer. It is never asked which one, and never offered another — being
 * nudged into connecting a second machine is what leaves an Account with a duplicate to repair.
 *
 * The first review found that offering the Account's machine had changed what the step *said*
 * without changing what it could *do*: the check only ran for a machine that had just arrived, a
 * verdict outlived the machine it answered for, and the step could not be left. Independent QA then
 * found the same dead end behind Start over.
 *
 * Every test drives the page, so each fails if the step goes back to knowing only a new arrival, or
 * starts asking which Computer to use.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingV2MockPage } from "./page.js";

/** Issuing a connect code is the only thing still on a clock before the Computer step. */
const ISSUE_MS = 300;
const CREATE_MS = 900;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Presses the control that stands in for the outside world doing the next thing. */
async function advanceMock(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await act(async () => undefined);
}

/** The listbox commits on a pointer sequence, not a bare click, the way a pointing device does. */
function chooseOption(control: HTMLElement, optionName: string) {
  fireEvent.click(control);
  const option = screen.getByRole("option", { name: optionName });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

/** What the Account owns before the flow starts, chosen the way a reviewer chooses it. */
function chooseInventory(title: string) {
  fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
  chooseOption(screen.getByLabelText("Computers on the account"), title);
  fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
}

/** Walks to the Computer step. Nothing is typed: the draft's default name is already valid. */
async function reachComputerStep() {
  fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // Agent-first setup creates the durable Agent on step one. The Computer step is not rendered
  // until that write completes, so the Review Lab's creation clock belongs here now.
  await advance(CREATE_MS);
  // The step's own effects — issuing a code, or probing the machine it prepares — settle here
  // rather than inside the assertions that read what they produced.
  await act(async () => undefined);
}

/** The line naming the Account's machine. Not a control: there is nothing here to operate. */
function machineLine(): string {
  return document.querySelector('[data-ui="onboarding-v2-computer"]')?.textContent ?? "";
}

function outcome(): string {
  return document.querySelector('[data-ui="onboarding-v2-check-outcome"]')?.textContent ?? "";
}

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
}

/** The connect command: the thing a reader should never be shown beside a machine they already own. */
function connectCommandShown(): boolean {
  return Array.from(document.querySelectorAll("code")).some((element) =>
    element.textContent?.includes('"$HOME/.local/bin/opentag" connect'),
  );
}

/** Anything that would ask the reader which Computer, or offer them another one. */
function asksWhichComputer(): boolean {
  return (
    screen.queryByRole("combobox") !== null ||
    screen.queryByText(/Connect a new computer/) !== null ||
    screen.queryByText(/Choose a computer/) !== null
  );
}

describe("the Computer the Account already has", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a computer when the Account has none", async () => {
    render(<OnboardingV2MockPage />);
    await reachComputerStep();
    await advance(ISSUE_MS);

    expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();
    // The first run is the one that has to connect, so this is where the command belongs.
    expect(connectCommandShown()).toBe(true);
    expect(asksWhichComputer()).toBe(false);
  });

  it("checks the machine the Account has rather than waiting for one to arrive", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();

    expect(screen.getByRole("heading", { name: "Your computer" })).toBeTruthy();
    expect(machineLine()).toContain("MacBook Pro");
    // The probe is running for the machine the Account has, not stalled waiting for an arrival.
    expect(outcome()).toContain("Waiting for the computer check…");
    expect(continueButton().disabled).toBe(true);

    await advanceMock("Return check result");
    expect(outcome()).toContain("Everything your agent needs is ready.");
    expect(continueButton().disabled).toBe(false);
  });

  it("leaves the step on a Computer that was already in the Account", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();
    await advanceMock("Return check result");

    fireEvent.click(continueButton());
    await advance(CREATE_MS);

    // Creating on the Account's own Computer is what lets the flow move on; before this it stayed
    // here forever, because leaving required a connection that was never going to happen.
    expect(screen.queryByRole("heading", { name: "Your computer" })).toBeNull();
  });

  it("spends no connect code on a run that already has a Computer", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();
    await advance(ISSUE_MS);

    // A code connects a *new* machine. Issuing one here would quietly hand a second Computer to an
    // Account that is meant to have one.
    expect(connectCommandShown()).toBe(false);
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
  });

  it("never asks which Computer, even for an Account that holds more than one", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("Several");
    await reachComputerStep();

    // An Account is meant to have one machine. One that predates that rule still gets no question
    // and no second connection — the reachable machine is prepared and named, and that is all.
    expect(asksWhichComputer()).toBe(false);
    expect(machineLine()).toContain("MacBook Pro");
    expect(machineLine()).not.toContain("Work iMac");
    expect(connectCommandShown()).toBe(false);

    await advanceMock("Return check result");
    expect(continueButton().disabled).toBe(false);
  });

  it("recovers the asleep Computer naturally before offering repair", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, offline");
    await reachComputerStep();
    await advance(ISSUE_MS);

    expect(machineLine()).toContain("Offline");
    expect(machineLine()).toContain("last seen 3 days ago");
    expect(
      screen.getByText(
        "MacBook Pro is offline. Run opentag daemon start in a terminal on that Computer; this page will continue when it reconnects.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." })).toBeTruthy();
    // Connecting a second machine is not the way to repair the first.
    expect(connectCommandShown()).toBe(false);
    expect(asksWhichComputer()).toBe(false);

    await advanceMock("Reconnect MacBook Pro");

    // The same machine came back, so the page picks the check up on its own — the promise the
    // offline line makes.
    expect(outcome()).toContain("Waiting for the computer check…");
    await advanceMock("Return check result");
    expect(continueButton().disabled).toBe(false);
    expect(machineLine()).toContain("Online");
  });

  it("drops a verdict when the lab switches to another Account, and asks again", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();
    await advanceMock("Return check result");
    expect(outcome()).toContain("Everything your agent needs is ready.");

    chooseInventory("Several");

    // A different Account is a different world, so an answer about the last one's machine cannot
    // stay on screen — the same machine id appears in more than one inventory, so nothing
    // downstream would notice on its own.
    expect(outcome()).not.toContain("Everything your agent needs is ready.");
    // Clearing it is only half of the job. A verdict taken away and never asked for again is what
    // left Start over waiting for an answer nobody was going to give.
    expect(screen.getByRole("button", { name: "Return check result" })).toBeTruthy();
  });

  it("does not offer Start over after the Agent has been durably created", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();
    expect(screen.getByRole("button", { name: "Return check result" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
  });
});

describe("the cloud route, which has no Computer of its own to point at", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("still creates the Agent when OpenTag allocates the machine", async () => {
    // The guard that stops a local run creating an Agent with no Computer must not stop a cloud
    // run, where the machine is allocated rather than connected or already owned.
    render(<OnboardingV2MockPage />);
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Offer the cloud computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock controls" }));
    fireEvent.click(screen.getByRole("button", { name: /Cloud computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /OpenTag agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(4_000);

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
  });
});
