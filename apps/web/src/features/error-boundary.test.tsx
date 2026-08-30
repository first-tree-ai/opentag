import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { createAppRouter } from "../router.js";
import { Route } from "../routes/__root.js";
import { AppErrorBoundary, RouteErrorPage, reportBoundaryError, rootErrorHandlers } from "./error-boundary.js";
import { StandaloneNotFoundPage } from "./not-found.js";

function ExplodingChild(): never {
  throw new Error(
    'Authorization: Bearer root-bearer-secret\nAuthorization: Basic dXNlcjpwYXNz\n"token": "json-token-secret"; password: \'quoted-password-secret\'',
  );
}

describe("application error boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps root and custom boundary diagnostics free of credential-shaped values", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalLocation = window.location;
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container, rootErrorHandlers);

    act(() => {
      root.render(
        <AppErrorBoundary>
          <ExplodingChild />
        </AppErrorBoundary>,
      );
    });

    try {
      const view = within(container);
      expect(view.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Try again" }));
      expect(reload).toHaveBeenCalledOnce();
      expect(view.getByRole("link", { name: "Back to Agents" }).getAttribute("href")).toBe("/agents");

      const logged = consoleError.mock.calls.map((args) => JSON.stringify(args)).join("\n");
      expect(logged).not.toContain("root-bearer-secret");
      expect(logged).not.toContain("dXNlcjpwYXNz");
      expect(logged).not.toContain("json-token-secret");
      expect(logged).not.toContain("quoted-password-secret");
      expect(consoleError).toHaveBeenCalledWith(
        "[OpenTag] Unhandled UI error",
        expect.objectContaining({
          boundary: "root",
          error: expect.objectContaining({
            message: expect.stringContaining("Authorization: Bearer [REDACTED]"),
          }),
        }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[OpenTag] Unhandled UI error",
        expect.objectContaining({
          boundary: "app",
          error: expect.objectContaining({
            message: expect.stringContaining("Authorization: [REDACTED]"),
          }),
        }),
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("takes ownership of route error and not-found fallbacks", () => {
    const router = createAppRouter();

    expect(Route.options.errorComponent).toBe(router.options.defaultErrorComponent);
    expect(Route.options.notFoundComponent).toBe(StandaloneNotFoundPage);
    expect(router.options.defaultNotFoundComponent).toBe(StandaloneNotFoundPage);
    expect(router.options.defaultOnCatch).toEqual(expect.any(Function));

    router.history.destroy();
  });

  it("renders the route fallback and retries the failed match", async () => {
    const reset = vi.fn();
    await renderInRouter(<RouteErrorPage reset={reset} />);

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Agents" }).getAttribute("href")).toBe("/agents");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("redacts the complete credential for non-Bearer authorization schemes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportBoundaryError("app", new Error("Authorization: Basic dXNlcjpwYXNz"));

    expect(consoleError).toHaveBeenCalledWith(
      "[OpenTag] Unhandled UI error",
      expect.objectContaining({
        error: expect.objectContaining({ message: "Authorization: [REDACTED]" }),
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("dXNlcjpwYXNz");
  });

  it("redacts complete Digest authorization parameters", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportBoundaryError(
      "app",
      new Error('Authorization: Digest username="u", response="secret-response", nonce="secret-nonce"'),
    );

    expect(consoleError).toHaveBeenCalledWith(
      "[OpenTag] Unhandled UI error",
      expect.objectContaining({
        error: expect.objectContaining({ message: "Authorization: [REDACTED]" }),
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-response");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret-nonce");
  });

  it("preserves JSON structure after a quoted authorization value", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportBoundaryError("app", new Error('{"authorization": "Bearer x", "safe": true}'));

    expect(consoleError).toHaveBeenCalledWith(
      "[OpenTag] Unhandled UI error",
      expect.objectContaining({
        error: expect.objectContaining({ message: '{"authorization": "Bearer [REDACTED]", "safe": true}' }),
      }),
    );
  });

  it("redacts complete multi-cookie and Set-Cookie header values", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportBoundaryError(
      "app",
      new Error("Cookie: theme=dark; sid=session-secret\nSet-Cookie: sid=set-session-secret; Path=/; HttpOnly"),
    );

    expect(consoleError).toHaveBeenCalledWith(
      "[OpenTag] Unhandled UI error",
      expect.objectContaining({
        error: expect.objectContaining({ message: "Cookie: [REDACTED]\nSet-Cookie: [REDACTED]" }),
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("session-secret");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("set-session-secret");
  });

  it("redacts serialized cookie collections without swallowing enclosing delimiters", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportBoundaryError(
      "app",
      new Error('{"Set-Cookie":["sid=first-session-secret", "refresh=second-session-secret"],"safe":true}'),
    );

    expect(consoleError).toHaveBeenCalledWith(
      "[OpenTag] Unhandled UI error",
      expect.objectContaining({
        error: expect.objectContaining({ message: '{"Set-Cookie":[REDACTED],"safe":true}' }),
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("first-session-secret");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("second-session-secret");
  });

  it("redacts comma-separated Set-Cookie values as one field", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportBoundaryError("app", new Error("Set-Cookie: sid=first-session-secret, refresh=second-session-secret"));

    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("first-session-secret");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("second-session-secret");
  });

  it("keeps the standalone fallback centered and bounded in production CSS", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app.css"), "utf8");

    expect(css).toMatch(/\.app-error-boundary\s*\{[^}]*min-height:\s*100%;[^}]*place-items:\s*center;/s);
    expect(css).toMatch(/\.app-error-boundary__card\s*\{[^}]*max-width:\s*36rem;/s);
  });
});
