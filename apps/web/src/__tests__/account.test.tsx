import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { installApi, json, openAccountMenu, resetWebAppState, userId } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("lets an Account update its global display name", async () => {
    installApi();
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(email.readOnly).toBe(true);
    expect(email.closest('[data-ui="field"]')).toBeTruthy();
    expect(displayName.closest('[data-ui="field"]')).toBeTruthy();
    fireEvent.change(displayName, { target: { value: "  Ada Lovelace  " } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(3),
    );
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada Lovelace");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/me",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ displayName: "  Ada Lovelace  " }) }),
    );
  });

  it("prevents duplicate account saves while a profile update is pending", async () => {
    let resolveUpdate: (response: Response) => void = () => undefined;
    const update = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    installApi({ profileUpdate: () => update });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Pending Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    fireEvent.submit(form);

    expect(((await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement).disabled).toBe(true);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    resolveUpdate(json({ id: userId, email: "ada@example.com", displayName: "Pending Name" }));
    await waitFor(() => expect(screen.getByText("Pending Name")).toBeTruthy());
  });

  it("treats a saved name whose refresh failed as needing synchronization, not as unsaved data", async () => {
    installApi({ meFailuresAfterProfileUpdate: 1 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Your display name was saved. OpenTag could not refresh the account, so the rest of the page still shows the previous name.",
    );
    // The write committed, so the page must not offer to repeat it, must not offer to discard it,
    // and must not describe the saved value as unsaved.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save account profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.queryByText("Account profile saved.")).toBeNull();
    expect(screen.getByText("Account not refreshed")).toBeTruthy();
    expect(displayName.value).toBe("Ada Lovelace");

    // Retry re-runs only the refresh; one PATCH was ever sent.
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));

    expect(await screen.findByText("Account profile saved.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Account not refreshed")).toBeNull();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("cannot repeat a committed save by submitting the form while its refresh is outstanding", async () => {
    installApi({ meFailuresAfterProfileUpdate: 99 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    // Save is hidden in this state, but the field still sits in an active form, so Enter would
    // submit it. The guard has to hold at the submit boundary, not only in the rendered controls.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    expect(screen.getByText("Account not refreshed")).toBeTruthy();
  });

  it("lets no new save race an in-flight refresh retry", async () => {
    installApi({ meFailuresAfterProfileUpdate: 1, meDelayMsAfterProfileUpdate: 40 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    const refreshesBeforeRetry = vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method !== "PATCH").length;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));

    // While the retry is in flight the field cannot be edited into a dirty state, a second retry
    // cannot start, and a submit cannot slip a competing write past it.
    expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeTruthy();
    expect(displayName.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refreshing…" }));
    fireEvent.submit(form);

    expect(await screen.findByText("Account profile saved.")).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    // Exactly one refresh was added by the retry: the second click never started another.
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method !== "PATCH"),
    ).toHaveLength(refreshesBeforeRetry + 1);
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });

  it("discards back to the saved name, never the stale one, while a refresh is outstanding", async () => {
    installApi({ meFailuresAfterProfileUpdate: 99 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    // Editing again reopens the unsaved-changes bar, and Discard must return to the saved value.
    fireEvent.change(displayName, { target: { value: "Third Name" } });
    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(displayName.value).toBe("Ada Lovelace");
    expect(await screen.findByText("Account not refreshed")).toBeTruthy();
  });

  it("restores the confirmed server name and shows the error when an account update fails", async () => {
    installApi({ profileUpdateFails: true });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Rejected Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Display name update failed");
    expect(displayName.value).toBe("Ada");
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("routes an Account with incomplete setup into onboarding without a legacy management scope", async () => {
    installApi({ workspaceless: true });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(screen.queryByRole("heading", { name: "OpenTag is not ready for this account" })).toBeNull();
  });

  it("keeps standalone onboarding reachable for an Account without completed setup", async () => {
    installApi({ workspaceless: true });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("routes an Account with incomplete setup into onboarding", async () => {
    installApi({ setupCompletedAt: null });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("lets an Account with no finished setup bind a Computer without leaving onboarding", async () => {
    /*
     * The recovery for an Agent that has no Computer has to work from inside the setup gate. It
     * once linked to that Agent's Computer settings, which lives under the shell that redirects
     * every Account with `setupCompletedAt === null` straight back to onboarding -- so the exit
     * returned the reader to the screen they were trying to leave. A hook test cannot see that:
     * only the real router mounts the route that redirects. So the recovery is rendered here, and
     * this test drives it to a working bind rather than asserting a link's href.
     */
    installApi({ setupCompletedAt: null, agentUnbound: true });
    render(<App />);

    expect(await screen.findByText("Reviewer has no computer yet.")).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    // Reachable and resolved right here, not merely advertised: the Account has one Computer, so
    // the Agent is put on it without the reader being asked which.

    // The reader is out: the Agent has a Computer, the resume that refused this run reads again and
    // continues. Asserting the blocked screen is gone is what a redirect loop could never satisfy.
    await waitFor(() => expect(screen.queryByText("Reviewer has no computer yet.")).toBeNull());
    // Still inside the gate throughout -- nothing navigated, so nothing could be redirected back.
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("lets an Account with several Computers choose one without leaving onboarding", async () => {
    /*
     * Which machine an Agent runs on is the reader's question when the Account holds more than one,
     * and this screen sits inside the setup gate -- so the choice has to be answerable here. A
     * refusal, or a pointer to somewhere behind the gate, would strand an Account that has several.
     */
    installApi({
      setupCompletedAt: null,
      agentUnbound: true,
      computers: () => [
        {
          id: "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e",
          displayName: "Ada's Mac",
          platform: "darwin",
          connectionStatus: "online",
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
        },
        {
          id: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9",
          displayName: "Spare",
          platform: "darwin",
          connectionStatus: "online",
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
        },
      ],
    });
    render(<App />);

    expect(await screen.findByText("Reviewer has no computer yet.")).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");

    // The second row, so this cannot pass by binding whichever Computer happens to be first.
    fireEvent.click(await screen.findByRole("button", { name: "Use Spare" }));

    await waitFor(() => expect(screen.queryByText("Reviewer has no computer yet.")).toBeNull());
    // Still inside the gate throughout -- nothing navigated, so nothing could be redirected back.
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("renders onboarding without the application navigation", async () => {
    installApi({ setupCompletedAt: null });
    render(<App />);
    await screen.findByRole("heading", { name: "Where should your agent run?" });

    // The Account has not entered the application yet. Every destination the primary navigation
    // offers is behind the setup gate, which sends them all straight back here, and the shell
    // brand would stand beside the one onboarding renders itself.
    // The sidebar is an <aside>, so it is `complementary`; asking for `navigation` here matched
    // nothing whether or not the shell rendered.
    expect(screen.queryByRole("complementary", { name: "Primary navigation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Agents" })).toBeNull();
    expect(screen.queryAllByRole("link", { name: "OpenTag" })).toHaveLength(0);
  });

  it("keeps completed Accounts out of onboarding even when it is requested directly", async () => {
    installApi();
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("keeps a staging re-board inspectable across its route handoff until it is explicitly finished", async () => {
    installApi({ bound: true, handoffReady: true, internalToolsOffered: true, provider: "slack" });
    const firstMount = render(<App />);

    const { menu } = await openAccountMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Internal tools" }));
    expect(await screen.findByRole("heading", { name: "Internal tools" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Re-board" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Re-board" }));

    expect(await screen.findByRole("heading", { name: "reviewer is ready." })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST"),
    ).toBe(false);

    // The review intent is tab-scoped as well as represented in search, so a browser/history
    // implementation that drops the search string still cannot turn a reload into auto-complete.
    firstMount.unmount();
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("button", { name: "Finish re-board" })).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Finish re-board" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST"),
    ).toBe(true);
  });

  it("keeps account controls personal and signs out from the account menu", async () => {
    installApi();
    render(<App />);
    const { menu } = await openAccountMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Account Menu" } });
    expect(await screen.findByRole("button", { name: "Save account profile" })).toBeTruthy();
    const { menu: accountMenu } = await openAccountMenu();
    fireEvent.click(within(accountMenu).getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/auth/browser/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not expose the previous Account while a post-logout route re-entry is loading", async () => {
    let releaseMe: (response: Response) => void = () => undefined;
    const pendingMe = new Promise<Response>((resolve) => {
      releaseMe = resolve;
    });
    installApi({ meAfterLogout: () => pendingMe });
    render(<App />);

    expect(await screen.findByRole("link", { name: "Open Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();

    await act(async () => {
      window.history.pushState({}, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByLabelText("Loading current server state")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Reviewer" })).toBeNull();

    await act(async () => {
      releaseMe(json({ error: { message: "Sign in required" } }, 401));
    });
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  });

  it("discards an Account refresh that outlived the session that started it", async () => {
    let releaseRefresh: (response: Response) => void = () => undefined;
    const pendingRefresh = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    let releaseMe: (response: Response) => void = () => undefined;
    const pendingMe = new Promise<Response>((resolve) => {
      releaseMe = resolve;
    });
    installApi({ meAfterProfileUpdate: () => pendingRefresh, meAfterLogout: () => pendingMe });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account profile" }));

    // Sign out while the refresh that save started is still in flight. Clearing the cache cannot
    // retire that read, because the cache never started it.
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();

    // It left with a cookie that was still valid, so it answers for the Account that just left.
    await act(async () => {
      releaseRefresh(
        json({
          user: { id: userId, email: "ada@example.com", displayName: "Ada Renamed" },
          setupCompletedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
    });

    await act(async () => {
      window.history.pushState({}, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByLabelText("Loading current server state")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Ada Renamed");
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();

    await act(async () => {
      releaseMe(json({ error: { message: "Sign in required" } }, 401));
    });
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  });

  it("opens the Computers page from the account menu", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    const computers = screen.getByRole("menuitem", { name: "Computers" });
    expect(computers.getAttribute("href")).toBe("/agents/computers");
    fireEvent.click(computers);
    expect(await screen.findByRole("heading", { level: 1, name: "Computers" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connected Computers" })).toBeTruthy();
    expect(screen.getByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/computers");
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("moves focus into account actions and returns it to the trigger on Escape", async () => {
    installApi({ multipleMemberships: true });
    render(<App />);
    const { menu, trigger } = await openAccountMenu();
    const account = within(menu).getByRole("menuitem", { name: "Account" });
    account.focus();
    fireEvent.keyDown(account, { key: "Escape" });

    /*
     * Closing is asynchronous: the menu is still in the document on the tick after Escape and
     * leaves a frame or two later. This waits for it rather than asserting immediately, which also
     * means the close finishes inside the test instead of racing whatever runs next.
     *
     * The old assertion asked for a menu accessibly named "Account" and got null at every moment,
     * open or closed — so it passed with the Escape line deleted entirely, and never checked the
     * focus return its name promises.
     */
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("supports arrow-key navigation and focus return in the account menu", async () => {
    installApi();
    render(<App />);
    const { menu, trigger } = await openAccountMenu();
    const account = within(menu).getByRole("menuitem", { name: "Account" });
    const signOut = within(menu).getByRole("menuitem", { name: "Sign out" });
    account.focus();
    fireEvent.keyDown(account, { key: "ArrowDown" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "ArrowDown" });
    fireEvent.keyDown(account, { key: "End" });
    fireEvent.keyDown(signOut, { key: "Escape" });
    // Same as above: closing is asynchronous, and a menu named "Account" never existed to be null.
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });
});
