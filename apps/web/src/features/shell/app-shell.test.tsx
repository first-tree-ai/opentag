import type { MeResponse } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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

/** Mobile uses the same mounted navigation, so drafts and focus survive viewport changes. */
describe("app shell on a narrow viewport", () => {
  afterEach(desktopViewport);

  it("offers inline navigation and account access without a drawer", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);
    expect(await screen.findByRole("link", { name: "Soul" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch Agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Agent navigation" })).toBeNull();
    await openAccountMenu();
    expect(screen.getByRole("menuitem", { name: "Computer" })).toBeTruthy();
  });

  it("retains the mounted navigation and content when the viewport changes", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);
    const soul = await screen.findByRole("link", { name: "Soul" });
    const content = document.querySelector("main");
    desktopViewport();
    fireEvent(window, new Event("resize"));
    expect(screen.getByRole("link", { name: "Soul" })).toBe(soul);
    expect(document.querySelector("main")).toBe(content);
  });

  it("returns to the workspace rail when leaving the Agent", async () => {
    mobileViewport();
    vi.spyOn(browserApi, "internalToolsOffered").mockResolvedValue(false);
    await renderShell(`/agents/${AGENT_ID}`);
    await screen.findByRole("link", { name: "Soul" });
    fireEvent.click(screen.getByRole("link", { name: "All Agents" }));
    await waitFor(() => expect(document.querySelector('[data-ui="account-shell"]')).toBeTruthy());
    expect(document.querySelector(".app-agent-navigation")?.hasAttribute("inert")).toBe(true);
  });
});
