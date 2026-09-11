import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { App } from "../app.js";
import { LoginPage } from "../features/auth/login-page.js";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { createQueryClient } from "../query/client.js";
import { queryKeys } from "../query/keys.js";
import { installApi, resetWebAppState, userId } from "./support/app-fixtures.js";
import { renderInRouter } from "./support/router.js";

const account = {
  user: { id: userId, email: "ada@example.com", displayName: "Ada" },
  setupCompletedAt: "2026-08-20T00:00:00.000Z",
};
const google = { id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" } as const;

function pendingRequest<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Login session entry", () => {
  beforeEach(resetWebAppState);
  afterEach(() => {
    vi.restoreAllMocks();
    overwriteGetLocale(() => "en");
  });

  it("waits for the session, then replaces login with the Agents page without showing sign-in controls", async () => {
    installApi();
    const pending = pendingRequest<typeof account>();
    vi.spyOn(browserApi, "me").mockReturnValueOnce(pending.promise).mockResolvedValue(account);
    const providers = vi.spyOn(browserApi, "authProviders");
    window.history.replaceState({}, "", "/login");
    const historyLength = window.history.length;
    render(<App />);

    expect((await screen.findByRole("status")).textContent).toContain("Checking your sign-in status…");
    expect(screen.queryByRole("heading", { name: "Sign in to OpenTag" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).toBeNull();
    expect(providers).not.toHaveBeenCalled();

    await act(async () => pending.resolve(account));
    expect(await screen.findByRole("heading", { name: "All Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(window.history.length).toBe(historyLength);
    expect(providers).not.toHaveBeenCalled();
  });

  it("resumes setup for an Account that has not completed admission", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/login");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(window.location.pathname).toBe("/agents/setup");
    expect(screen.queryByRole("heading", { name: "Sign in to OpenTag" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "All Agents" })).toBeNull();
  });

  it("preserves the requested destination and its search parameters", async () => {
    installApi();
    const next = "/agents/computers?from=login";
    window.history.replaceState({}, "", `/login?next=${encodeURIComponent(next)}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Computers" })).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(next);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/api/v1/auth/browser/logout",
    "/login",
    "/login?next=/agents",
    "/agents/../login",
    "/agents/%2e%2e/login",
    "/agents/../../api/v1/me",
  ])("falls back to Agents for an unsafe or looping destination: %s", async (next) => {
    installApi();
    window.history.replaceState({}, "", `/login?next=${encodeURIComponent(next)}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "All Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(window.location.search).toBe("");
  });

  it("shows the existing login form when the server reports an expired session", async () => {
    installApi({ unauthenticated: true, authProviders: [google] });
    window.history.replaceState({}, "", "/login");
    render(<App />);

    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in to OpenTag" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByText("Checking your sign-in status…")).toBeNull();
  });

  it.each([new Error("Offline"), new ApiError(503, "Unavailable"), new ApiError(403, "Forbidden")])(
    "offers retry rather than assuming sign-out when verification fails: %s",
    async (failure) => {
      installApi({ unauthenticated: true, authProviders: [google] });
      vi.spyOn(browserApi, "me")
        .mockRejectedValueOnce(failure)
        .mockRejectedValue(new ApiError(401, "Sign in required"));
      const providers = vi.spyOn(browserApi, "authProviders");
      window.history.replaceState({}, "", "/login");
      render(<App />);

      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Unable to check sign-in status" })).toBeTruthy();
      expect(providers).not.toHaveBeenCalled();
      expect(screen.queryByRole("link", { name: "Sign in with Google" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("can recover verification directly into the application", async () => {
    installApi();
    vi.spyOn(browserApi, "me").mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(account);
    window.history.replaceState({}, "", "/login");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "All Agents" })).toBeTruthy();
  });

  it("shows a retryable error when the browser is already offline", async () => {
    onlineManager.setOnline(false);
    try {
      vi.spyOn(browserApi, "me").mockRejectedValue(new Error("Offline"));
      await renderInRouter(<LoginPage />);
      expect(await screen.findByRole("heading", { name: "Unable to check sign-in status" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(false);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("offers retry after ten seconds instead of leaving a stalled session check on screen", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(browserApi, "me").mockReturnValue(new Promise(() => undefined));
      await renderInRouter(<LoginPage />);
      await act(async () => vi.advanceTimersByTimeAsync(10_001));
      expect(screen.getByRole("heading", { name: "Unable to check sign-in status" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(false);
      expect(screen.queryByText("Checking your sign-in status…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates cached Account data and keeps the sign-in form stable after a 401", async () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.me(), account);
    const pending = pendingRequest<typeof account>();
    const me = vi.spyOn(browserApi, "me").mockReturnValue(pending.promise);
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({
      providers: [{ id: "password", enabled: true, startUrl: null }],
    });
    await renderInRouter(
      <QueryClientProvider client={client}>
        <LoginPage />
      </QueryClientProvider>,
      { path: "/login" },
    );

    expect(screen.getByRole("status").textContent).toContain("Checking your sign-in status…");
    expect(screen.queryByLabelText("Email")).toBeNull();
    await act(async () => pending.reject(new ApiError(401, "Session expired")));
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    await act(async () => client.invalidateQueries({ queryKey: queryKeys.me() }));
    expect(screen.getByLabelText("Email")).toBe(email);
    expect(email.value).toBe("ada@example.com");
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("reports session loading and verification errors in Chinese", async () => {
    overwriteGetLocale(() => "zh");
    const pending = pendingRequest<typeof account>();
    vi.spyOn(browserApi, "me").mockReturnValue(pending.promise);
    await renderInRouter(<LoginPage />);

    expect(screen.getByRole("status").textContent).toContain("正在检查登录状态…");
    await act(async () => pending.reject(new Error("Offline")));
    expect(await screen.findByRole("heading", { name: "无法检查登录状态" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "再试一次" })).toBeTruthy();
  });
});
