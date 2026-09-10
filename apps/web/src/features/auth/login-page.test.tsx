import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { ApiError, browserApi } from "../../api.js";
import * as locale from "../../i18n/locale.js";
import { overwriteGetLocale } from "../../paraglide/runtime.js";
import { queryKeys } from "../../query/keys.js";
import { Button } from "../../ui/design-system.js";
import { LoginPage } from "./login-page.js";

const password = { id: "password", enabled: true, startUrl: null } as const;
const google = { id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" } as const;

function pendingRequest<T>() {
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function RefreshProviders() {
  const client = useQueryClient();
  return (
    <Button onClick={() => void client.invalidateQueries({ queryKey: queryKeys.authProviders() })}>Refresh</Button>
  );
}

describe("LoginPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    overwriteGetLocale(() => "en");
  });

  it("separates password sign-in from external providers", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({
      providers: [
        { id: "password", enabled: true, startUrl: null },
        { id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" },
      ],
    });
    await renderInRouter(<LoginPage next="/agents" />);
    expect(await screen.findByRole("heading", { name: "Sign in to OpenTag" })).toBeTruthy();
    expect(screen.getByText("or")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toBeTruthy();
  });

  it("explains when no enabled provider is available", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({
      providers: [{ id: "password", enabled: false, startUrl: null }],
    });
    await renderInRouter(<LoginPage />);
    expect(await screen.findByText("No sign-in methods are currently available.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign-in unavailable" })).toBeTruthy();
    expect(screen.getByText("Contact your OpenTag administrator for help.")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("keeps Google-only sign-in free of password and registration controls", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({
      providers: [
        { ...google, startUrl: `${google.startUrl}?prompt=select_account` },
        { ...password, enabled: false },
      ],
    });
    const next = "/settings/profile?tab=security&from=login";
    await renderInRouter(<LoginPage next={next} />);
    const link = await screen.findByRole("link", { name: "Sign in with Google" });
    const href = new URL(link.getAttribute("href") ?? "", window.location.origin);
    expect(href.searchParams.get("next")).toBe(next);
    expect(href.searchParams.get("prompt")).toBe("select_account");
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create one" })).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
  });

  it("shows the password form without a divider when it is the only enabled method", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({ providers: [password, { ...google, enabled: false }] });
    await renderInRouter(<LoginPage />);
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
  });

  it("announces provider loading and offers a working retry after failure", async () => {
    const pending = pendingRequest<Awaited<ReturnType<typeof browserApi.authProviders>>>();
    vi.spyOn(browserApi, "authProviders")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ providers: [google] });
    await renderInRouter(<LoginPage />);
    expect(screen.getByRole("status").textContent).toContain("Loading sign-in methods…");
    expect(screen.queryByRole("link")).toBeNull();
    await act(async () => pending.reject(new Error("Offline")));
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to load sign-in methods");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves entered credentials when refreshing providers fails in the background", async () => {
    vi.spyOn(browserApi, "authProviders")
      .mockResolvedValueOnce({ providers: [password] })
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ providers: [password] });
    await renderInRouter(
      <>
        <LoginPage />
        <RefreshProviders />
      </>,
    );
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Email")).toBe(email);
    expect(email.value).toBe("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(email.value).toBe("ada@example.com");
  });

  it("changes the whole card to registration and masks the password on mode changes", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({ providers: [google, password] });
    await renderInRouter(<LoginPage />);
    const input = (await screen.findByLabelText("Password")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");
    expect(input.getAttribute("autocapitalize")).toBe("none");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign up with Google" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(input.type).toBe("password");
    expect(input.value).toBe("a-long-password");
    expect(input.minLength).toBe(12);
    expect(input.autocomplete).toBe("new-password");
    expect(screen.getByText("At least 12 characters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in to OpenTag" })).toBeTruthy();
    expect(input.autocomplete).toBe("current-password");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("prevents competing actions and duplicate submissions, then restores inputs after rejection", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({ providers: [google, password] });
    const pending = pendingRequest<void>();
    const signIn = vi.spyOn(browserApi, "signInWithPassword").mockReturnValue(pending.promise);
    await renderInRouter(<LoginPage />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.change(input, { target: { value: "a-long-password" } });
    const form = email.closest("form");
    if (!form) throw new Error("Expected a sign-in form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(email.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Signing in…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create one" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("combobox", { name: "Language" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("link", { name: "Sign in with Google" }).getAttribute("href")).toBeNull();
    await act(async () => pending.reject(new ApiError(401, "The email address or password is incorrect")));
    expect((await screen.findByRole("alert")).textContent).toBe("The email address or password is incorrect");
    expect(email.disabled).toBe(false);
    expect(email.value).toBe("ada@example.com");
    expect(input.value).toBe("a-long-password");
    expect(screen.getByRole("link", { name: "Sign in with Google" }).getAttribute("href")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Language" }).hasAttribute("disabled")).toBe(false);
  });

  it("renders visible Google text in Chinese and exposes the active language", async () => {
    overwriteGetLocale(() => "zh");
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({ providers: [google] });
    await renderInRouter(<LoginPage />);
    const link = await screen.findByRole("link", { name: "使用 Google 登录" });
    expect(link.textContent).toBe("使用 Google 登录");
    expect(screen.getByRole("heading", { name: "登录 OpenTag" })).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("lang")).toBe("zh");
  });

  it("lets an unauthenticated visitor switch languages", async () => {
    const setLocale = vi.spyOn(locale, "setLocale");
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({ providers: [google] });
    await renderInRouter(<LoginPage />);
    fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
    const option = await screen.findByRole("option", { name: "中文" });
    fireEvent.pointerMove(option);
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
    await waitFor(() => expect(setLocale).toHaveBeenCalledWith("zh"));
  });
});
