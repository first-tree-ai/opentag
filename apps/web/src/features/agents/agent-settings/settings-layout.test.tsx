import { Link, useRouterState } from "@tanstack/react-router";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { UnsavedChangesGuard } from "./settings-layout.js";

function LocationProbe() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <output>{pathname}</output>;
}

describe("UnsavedChangesGuard", () => {
  it("keeps an edited settings page in place until the reader explicitly discards changes", async () => {
    await renderInRouter(
      <>
        <UnsavedChangesGuard when />
        <Link to="/account">Leave</Link>
        <LocationProbe />
      </>,
      { path: "/settings" },
    );

    fireEvent.click(screen.getByRole("link", { name: "Leave" }));
    expect(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
    expect(screen.getByText("/settings")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("/settings")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Leave" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByText("/account")).toBeTruthy();
  });
});
