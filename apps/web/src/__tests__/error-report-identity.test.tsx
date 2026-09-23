import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  createErrorReportSink,
  forwardErrorReport,
  resetErrorReportContext,
  setErrorReportSink,
} from "../observability/error-reporting.js";
import { installApi, openAccountMenu, resetWebAppState, userId } from "./support/app-fixtures.js";

/**
 * Installs a real sink over a recording relay and returns a probe that files one failure and
 * answers with the report the relay received, so what a report would say about the Account on
 * screen is read from the wire rather than from module state.
 */
function installReportProbe() {
  const relay = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
  setErrorReportSink(
    createErrorReportSink({
      fetchImpl: relay,
      target: () => ({
        location: { href: "https://opentag.example/agents" } as Location,
        navigator: { userAgent: "Mozilla/5.0 (test)" } as Navigator,
      }),
    }),
  );
  let filed = 0;
  return async (): Promise<{ userId?: string }> => {
    filed += 1;
    // A distinct message per probe, so the sink's cooldown never swallows one.
    forwardErrorReport({ code: "unhandled_error", message: `probe ${filed}` });
    await waitFor(() => expect(relay).toHaveBeenCalledTimes(filed));
    return JSON.parse(String(relay.mock.calls[filed - 1]?.[1]?.body));
  };
}

async function navigateTo(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("error report identity", () => {
  beforeEach(resetWebAppState);
  afterEach(() => {
    setErrorReportSink(undefined);
    resetErrorReportContext();
  });

  it("names the Account once it is on screen and forgets it when the Account signs out", async () => {
    installApi();
    const probe = installReportProbe();
    render(<App />);
    expect(await screen.findByRole("link", { name: "Open Reviewer" })).toBeTruthy();

    expect((await probe()).userId).toBe(userId);

    const { menu } = await openAccountMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to OpenTag" })).toBeTruthy();

    // The login page that follows, and every page after it, is no longer the Account that left.
    expect((await probe()).userId).toBeUndefined();
  });

  it("forgets the Account when the Server refuses the session, without anyone pressing Sign out", async () => {
    let expired = false;
    installApi({ sessionExpired: () => expired });
    const probe = installReportProbe();
    render(<App />);
    expect(await screen.findByRole("link", { name: "Open Reviewer" })).toBeTruthy();
    expect((await probe()).userId).toBe(userId);

    // The session lapses while the reader is elsewhere; the next signed-in surface re-reads /me,
    // is refused, and that refusal is the exit the gate releases the identity on.
    expired = true;
    await navigateTo("/login");
    expect(await screen.findByRole("heading", { name: "Sign in to OpenTag" })).toBeTruthy();
    await navigateTo("/agents");
    await waitFor(() => expect(window.location.search).toContain("next="));
    expect(window.location.pathname).toBe("/login");

    expect((await probe()).userId).toBeUndefined();
  });
});
