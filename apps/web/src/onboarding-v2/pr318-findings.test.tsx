/**
 * Probe for the review of `40e082c`, which found that offering a Computer the Account already has
 * had changed what the step *says* without changing what it can *do*: the check only ever ran for a
 * machine that had just arrived, a verdict outlived the machine it answered for, the asleep machine
 * could only be "repaired" by enrolling a second one, and the flow could not be left on a Computer
 * that was not freshly connected.
 *
 * Every test here drives the four inventories through the page, so each one fails if the step goes
 * back to knowing only a new arrival.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingV2MockPage } from "./page.js";

/** Issuing a connect code is the only thing still on a clock before the Computer step. */
const ISSUE_MS = 300;
const CREATE_MS = 900;

const ONLINE_MAC = "MacBook Pro · Online";
const OFFLINE_MAC = "MacBook Pro · Offline · last seen 3 days ago";
const OFFLINE_IMAC = "Work iMac · Offline · last seen 3 days ago";
const NEW_COMPUTER = "Connect a new computer…";

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
  // The step's own effects — issuing a code, or probing the machine that was chosen — settle here
  // rather than inside the assertions that read what they produced.
  await act(async () => undefined);
}

function computerControl(): HTMLElement {
  return screen.getByLabelText("Computer");
}

function chooseComputer(optionName: string) {
  chooseOption(computerControl(), optionName);
}

/** What the control says it is set to — the Kumo select shows the chosen row's own label. */
function chosenComputer(): string {
  return computerControl().textContent ?? "";
}

function outcome(): string {
  return document.querySelector('[data-ui="onboarding-v2-check-outcome"]')?.textContent ?? "";
}

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
}

/** The enroll command: the thing a reader should never be shown beside a machine they already own. */
function enrollCommandShown(): boolean {
  return screen.queryByText(/opentag computer connect/) !== null;
}

describe("a Computer the Account already has", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks nothing about which Computer when the Account has none", async () => {
    render(<OnboardingV2MockPage />);
    await reachComputerStep();
    await advance(ISSUE_MS);

    expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();
    expect(screen.queryByLabelText("Computer")).toBeNull();
    // The first run is the one that has to enroll, so this is where the command belongs.
    expect(enrollCommandShown()).toBe(true);
  });

  it("checks the chosen Computer rather than waiting for one to arrive", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();

    expect(screen.getByRole("heading", { name: "Choose a computer" })).toBeTruthy();
    // The probe is running for the machine that was chosen, not stalled waiting for an arrival.
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

    // Creating on an already-owned Computer is what lets the flow move on; before this it stayed
    // here forever, because leaving required a connection that was never going to happen.
    expect(screen.queryByRole("heading", { name: "Choose a computer" })).toBeNull();
  });

  it("spends no connect code on a run that is reusing a Computer", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, online");
    await reachComputerStep();
    await advance(ISSUE_MS);

    // A code enrolls a *new* machine. Issuing one here would quietly offer a second Computer to a
    // reader who came to reuse the one they have.
    expect(enrollCommandShown()).toBe(false);
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
  });

  it("takes the previous machine's verdict off the screen when the choice changes", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("Several");
    await reachComputerStep();
    await advanceMock("Return check result");
    expect(outcome()).toContain("Everything your agent needs is ready.");

    chooseComputer(OFFLINE_IMAC);

    // The verdict answered for the MacBook. Left on screen it would read as the iMac's.
    expect(outcome()).not.toContain("Everything your agent needs is ready.");
    expect(continueButton().disabled).toBe(true);

    chooseComputer(ONLINE_MAC);
    expect(outcome()).toContain("Waiting for the computer check…");
    expect(continueButton().disabled).toBe(true);
  });

  it("repairs the asleep Computer instead of offering another one", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("One, offline");
    await reachComputerStep();
    await advance(ISSUE_MS);

    // Preselected even though it cannot be reached: the alternative nudges someone whose only
    // machine is asleep into enrolling a second one.
    expect(chosenComputer()).toContain(OFFLINE_MAC);
    expect(
      screen.getByText("This computer is offline. Reconnect it and this page will continue on its own."),
    ).toBeTruthy();
    expect(enrollCommandShown()).toBe(false);

    await advanceMock("Reconnect MacBook Pro");

    // The same machine came back, so the page picks the check up on its own — the promise the
    // offline line makes.
    expect(outcome()).toContain("Waiting for the computer check…");
    await advanceMock("Return check result");
    expect(continueButton().disabled).toBe(false);
    // The same machine, now reachable — not a second one added beside it.
    expect(chosenComputer()).toContain(ONLINE_MAC);
  });

  it("preselects a reachable Computer over an unreachable one", async () => {
    render(<OnboardingV2MockPage />);
    chooseInventory("Several");
    await reachComputerStep();

    expect(chosenComputer()).toContain(ONLINE_MAC);

    // The unreachable machine is still offered, and connecting a new one is the last item of the
    // same control rather than a second thing to answer.
    fireEvent.click(computerControl());
    expect(screen.getByRole("option", { name: OFFLINE_IMAC })).toBeTruthy();
    expect(screen.getByRole("option", { name: NEW_COMPUTER })).toBeTruthy();
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
    // run, where the machine is allocated rather than connected or chosen.
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
