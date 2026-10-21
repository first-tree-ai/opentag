import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { AppErrorBoundary, RouteErrorPage } from "./error-boundary.js";
import { StandaloneNotFoundPage } from "./not-found.js";

function ExplodingChild(): never {
  throw new Error("boom");
}

/**
 * These pages can render outside the Router, Query, and Account contexts, so their sign-out
 * cannot rely on any of them: it asks the Server, then reloads onto sign-in.
 */
describe("sign-out on error and not-found pages", () => {
  const originalLocation = window.location;
  const assign = vi.fn();

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    assign.mockReset();
  });

  function stubServer(response: Response) {
    vi.mocked(fetch).mockImplementation(async () => response);
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
  }

  it("signs out from the application boundary without any provider and leaves for sign-in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServer(new Response(null, { status: 204 }));
    render(
      <AppErrorBoundary>
        <ExplodingChild />
      </AppErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/browser/logout", expect.objectContaining({ method: "POST" }));
  });

  it("keeps the boundary intact and reports the failure when the logout is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServer(
      new Response(JSON.stringify({ error: { message: "Logout unavailable" } }), {
        headers: { "content-type": "application/json" },
        status: 503,
      }),
    );
    render(
      <AppErrorBoundary>
        <ExplodingChild />
      </AppErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Request failed");
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
  });

  it("offers it on the not-found page", async () => {
    stubServer(new Response(null, { status: 204 }));
    await renderInRouter(<StandaloneNotFoundPage />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("offers it on the route error page", async () => {
    stubServer(new Response(null, { status: 204 }));
    await renderInRouter(<RouteErrorPage error={new Error("boom")} reset={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });
});
