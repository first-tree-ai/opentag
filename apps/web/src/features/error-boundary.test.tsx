import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router.js";
import { Route } from "../routes/__root.js";
import { AppErrorBoundary } from "./error-boundary.js";
import { StandaloneNotFoundPage } from "./not-found.js";

function ExplodingChild(): never {
  throw new Error("token: secret-value");
}

describe("application error boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps an unexpected render failure recoverable and redacts credential-shaped diagnostics", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <AppErrorBoundary>
        <ExplodingChild />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Agents" }).getAttribute("href")).toBe("/agents");
    expect(consoleError).toHaveBeenCalledWith(
      "[OpenTag] Unhandled UI error",
      expect.objectContaining({
        boundary: "app",
        error: expect.objectContaining({ message: "token=[REDACTED]" }),
      }),
    );
  });

  it("takes ownership of route error and not-found fallbacks", () => {
    const router = createAppRouter();

    expect(Route.options.errorComponent).toBe(router.options.defaultErrorComponent);
    expect(Route.options.notFoundComponent).toBe(StandaloneNotFoundPage);
    expect(router.options.defaultNotFoundComponent).toBe(StandaloneNotFoundPage);
    expect(router.options.defaultOnCatch).toEqual(expect.any(Function));

    router.history.destroy();
  });
});
