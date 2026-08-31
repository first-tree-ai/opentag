import type { MeResponse } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { browserApi } from "../../api.js";
import { AccountContext } from "../session/session-context.js";
import { AppShell } from "./app-shell.js";

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

async function renderShell() {
  await renderInRouter(
    <AccountContext value={{ me, endSession: vi.fn(), refreshMe: vi.fn().mockResolvedValue(me), reloadMe: vi.fn() }}>
      <AppShell />
    </AccountContext>,
    { path: "/" },
  );
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
