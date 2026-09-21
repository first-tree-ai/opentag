import type { MeResponse } from "@opentag/shared/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { browserApi } from "../../api.js";
import { AccountContext } from "../session/session-context.js";
import { AppShell, agentIdFromPathname } from "./app-shell.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const me = {
  user: {
    id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
    email: "tester@company.example",
    displayName: "Tester",
  },
  setupCompletedAt: "2026-08-01T00:00:00.000Z",
} as unknown as MeResponse;

/** The entry lives in the account menu, which renders its items only while it is open. */
async function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  await screen.findByRole("menuitem", { name: "Sign out" });
}

async function renderShell(path = "/") {
  await renderInRouter(
    <AccountContext value={{ me, endSession: vi.fn(), refreshMe: vi.fn().mockResolvedValue(me), reloadMe: vi.fn() }}>
      <AppShell />
    </AccountContext>,
    { path },
  );
}

/** The narrow layout the shell switches on, as the real browser reports it. */
function mobileViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/** The mobile drawer, which is the sidebar element the focus trap is attached to. */
async function findDrawer(): Promise<HTMLElement> {
  return waitFor(() => {
    const drawer = document.querySelector<HTMLElement>(".app-navigation");
    if (!drawer) throw new Error("the drawer is not mounted");
    return drawer;
  });
}

/** The wide layout, which is the default the setup file installs. */
function desktopViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe("app shell internal tools entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the internal tools where the deployment answers that it has them", async () => {
    const offered = vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(true);
    await renderShell();
    await waitFor(() => expect(offered).toHaveBeenCalled());
    await openAccountMenu();

    expect(screen.getByRole("menuitem", { name: "Internal tools" })).toBeTruthy();
  });

  it("shows production exactly what it shows today, since the Server offers no internal tools", async () => {
    const offered = vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell();

    await waitFor(() => expect(offered).toHaveBeenCalled());
    await openAccountMenu();

    expect(screen.queryByRole("menuitem", { name: "Internal tools" })).toBeNull();
  });

  it("keeps the entry hidden when the probe itself fails, rather than guessing", async () => {
    const offered = vi.spyOn(browserApi, "internalToolsOffered").mockRejectedValue(new Error("probe failed"));
    await renderShell();
    await waitFor(() => expect(offered).toHaveBeenCalled());
    await openAccountMenu();

    expect(screen.queryByRole("menuitem", { name: "Internal tools" })).toBeNull();
  });
});

/**
 * The Account/Agent scope the shell switches on, read straight from the pathname. The account-only
 * segments are the subtle part: `/agents/new` and `/agents/setup` are Account pages that happen to
 * live under the Agent prefix, and reading them as an Agent id would mount an Agent shell that has
 * no Agent behind it.
 */
describe("agent scope from the pathname", () => {
  it.each([
    ["/agents", undefined],
    ["/agents/", undefined],
    ["/", undefined],
    ["/agents/new", undefined],
    ["/agents/setup", undefined],
    ["/agents/computers", undefined],
    ["/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24", "1a63a21e-f6c7-4474-91ea-4dabf0566a24"],
    ["/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24/tasks", "1a63a21e-f6c7-4474-91ea-4dabf0566a24"],
    ["/settings", undefined],
  ])("reads %s as %s", (pathname, expected) => {
    expect(agentIdFromPathname(pathname)).toBe(expected);
  });

  it("marks the workspace scope on an Account page and names the Account navigation", async () => {
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell("/agents");

    const shell = document.querySelector('[data-ui="account-shell"]') as HTMLElement | null;
    expect(shell).toBeTruthy();
    expect(shell?.getAttribute("data-scope")).toBe("workspace");
    expect(screen.getByRole("navigation", { name: "Account Agents" })).toBeTruthy();
    // The Agent navigation is inert while no Agent is open, rather than absent.
    expect(document.querySelector(".app-agent-navigation")?.hasAttribute("inert")).toBe(true);
  });

  it("marks the agent scope on an Agent page and names the Agent navigation", async () => {
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    const shell = document.querySelector('[data-ui="agent-shell"]') as HTMLElement | null;
    expect(shell).toBeTruthy();
    expect(shell?.getAttribute("data-scope")).toBe("agent");
    expect(screen.getByRole("complementary", { name: "Agent navigation" })).toBeTruthy();
    expect(document.querySelector(".app-agent-navigation")?.hasAttribute("inert")).toBe(false);
  });

  it("marks the home link current only on the exact Agents list", async () => {
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell("/agents");

    expect(screen.getByRole("link", { name: "All Agents" }).getAttribute("aria-current")).toBe("page");
  });

  it("leaves the home link not-current on an Agent page", async () => {
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    // The desktop link inside the sidebar navigation, which is the one that carries aria-current.
    const home = screen
      .getAllByRole("link", { name: "All Agents" })
      .find((node) => node.getAttribute("aria-label") === "All Agents");
    expect(home?.getAttribute("aria-current")).toBeNull();
  });
});

/**
 * The narrow layout. It changes what exists rather than only what is visible: the drawer, the mobile
 * header, and the focus trap that keeps Tab inside the open drawer.
 */
describe("app shell on a narrow viewport", () => {
  afterEach(() => {
    desktopViewport();
  });

  it("collapses the sidebar to icons and offers the drawer trigger on an Agent page", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    expect(await screen.findByRole("link", { name: "All Agents" })).toBeTruthy();
    expect(document.querySelector(".app-mobile-header")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Agent navigation" })).toBeTruthy();
    // The sidebar collapses to icons on a narrow viewport, which is what the trigger opens.
    expect(document.querySelector('[data-sidebar="collapsible"]')?.getAttribute("data-collapsible")).not.toBeNull();
  });

  it("keeps the drawer closed to Tab by wrapping from the last control back to the first", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    // The drawer is the sidebar itself, which carries the focus trap while the layout is narrow.
    const drawer = await findDrawer();
    const controls = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')];
    expect(controls.length).toBeGreaterThan(1);
    const first = controls[0] as HTMLElement;
    const last = controls.at(-1) as HTMLElement;
    // jsdom reports no client rects, so the guard would drop every control; give them one.
    for (const node of controls) vi.spyOn(node, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);

    last.focus();
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("leaves Tab alone while focus is not on the drawer's boundary", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    const drawer = await findDrawer();
    const controls = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')];
    for (const node of controls) vi.spyOn(node, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);

    (controls[0] as HTMLElement).focus();
    // A forward Tab from the first control is the browser's own business, not the trap's.
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(document.activeElement).toBe(controls[0]);
  });

  it("ignores a key the focus trap does not own", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    const drawer = await findDrawer();
    (
      drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')[0] as HTMLElement
    )?.focus();

    expect(() => fireEvent.keyDown(drawer, { key: "Escape" })).not.toThrow();
  });

  it("dismisses the drawer and retires the outgoing Agent once the reader navigates to the Account scope", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);

    // The Agent navigation resolves lazily, so it is what proves the Agent scope was mounted.
    expect(await screen.findByRole("button", { name: "Open Agent navigation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "All Agents" }));

    // Leaving an Agent keeps its labels briefly, then releases them; leaving the drawer behind
    // would strand an open drawer on a page that has no Agent to navigate.
    await waitFor(() => {
      expect(document.querySelector('[data-ui="account-shell"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-ui="account-shell"]')?.getAttribute("data-scope")).toBe("workspace");

    // Leaving the Agent releases its labels after a brief fade, which is what the timer is for.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(document.querySelector('[data-ui="account-shell"]')?.getAttribute("data-scope")).toBe("workspace");
  });
});
