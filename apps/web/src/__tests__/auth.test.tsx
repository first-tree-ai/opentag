import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { PasswordSignInForm } from "../features/auth/password-sign-in-form.js";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it.each(["/", "/agents"])("redirects unauthenticated protected path %s to login", async (path) => {
    installApi({ unauthenticated: true });
    window.history.replaceState({}, "", path);
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Welcome back" });
    expect(heading.closest("main")?.getAttribute("data-ui")).toBe("login-page");
    expect(screen.getByText("OpenTag").closest('[data-ui="login-brand-lockup"]')).toBeTruthy();
    expect(screen.getByText("Sign in to continue to OpenTag.")).toBeTruthy();
    expect(screen.queryByText(/Permissions are checked/)).toBeNull();
    const expectedNext = path === "/" ? "/agents" : path;
    expect(window.location.search).toBe(`?next=${encodeURIComponent(expectedNext)}`);
  });

  it("renders the Google provider with its branded sign-in treatment", async () => {
    installApi({
      authProviders: [{ id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const signIn = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(signIn.getAttribute("data-ui")).toBe("login-provider-google");
    expect(signIn.querySelector('img[alt="Sign in with Google"]')).toBeTruthy();
    expect(new URL(signIn.getAttribute("href") ?? "", window.location.origin).searchParams.get("next")).toBe("/agents");
    expect(screen.getByText("Sign in to manage your Agents and Computers.")).toBeTruthy();
  });

  /*
   * The login surface itself, not a re-composition of it. A test that calls authProviderLabel and
   * builds the sentence the way the component does would keep passing if the component went back to
   * interpolating provider.id -- which is the regression this exists to catch. Only `dev` reaches
   * this sentence in production: `google` renders as an image and `password` as a form.
   */
  it("names the sign-in method on the button rather than its identifier", async () => {
    installApi({
      authProviders: [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const link = await screen.findByRole("link", { name: "Continue with Developer sign-in" });
    expect(link.getAttribute("data-ui")).toBe("login-provider");
    expect(screen.queryByRole("link", { name: /dev/ })).toBeNull();
  });

  it("reads the same button in Chinese", async () => {
    overwriteGetLocale(() => "zh");
    try {
      installApi({
        authProviders: [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }],
        unauthenticated: true,
      });
      window.history.replaceState({}, "", "/agents");
      render(<App />);

      expect(await screen.findByRole("link", { name: "使用开发者登录继续" })).toBeTruthy();
    } finally {
      overwriteGetLocale(() => "en");
    }
  });

  it("offers the password form only where the server enabled it", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: false, startUrl: null }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    // Disabled with nothing else available, so the page says so rather than showing an inert form.
    expect(await screen.findByText("No sign-in methods are currently available.")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("signs in with an email address and password", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    // Registration is the only mode that asks for a name, so sign-in must not be showing that field.
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/auth/email/sign-in");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        email: "ada@example.com",
        password: "correct-horse-battery",
      });
    });
  });

  it("asks for a name when registering, and posts it with the credential", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Create one" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Account" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/auth/email/sign-up");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        displayName: "New Account",
        email: "new@example.com",
        password: "correct-horse-battery",
      });
    });
  });

  it.each([["https://evil.example"], ["//evil.example"], ["/\\evil.example"], ["/api/v1/me"], ["/agents#/../evil"]])(
    "refuses to land a password sign-in on %s",
    async (next) => {
      const navigate = vi.fn();
      installApi({
        authProviders: [{ id: "password", enabled: true, startUrl: null }],
        unauthenticated: true,
      });
      render(<PasswordSignInForm navigate={navigate} next={next} />);

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      /*
       * This is the one sign-in method that navigates the browser itself rather than handing its destination to a
       * server route, so it has to apply the same allowlist the redirect providers have always been given.
       */
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate).toHaveBeenCalledWith("/agents");
    },
  );

  it("lands a password sign-in on an allowed destination it was asked for", async () => {
    const navigate = vi.fn();
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      unauthenticated: true,
    });
    render(<PasswordSignInForm navigate={navigate} next="/settings/profile" />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings/profile"));
  });

  it("does not navigate when the credential was refused", async () => {
    const navigate = vi.fn();
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      passwordSignInFails: true,
      unauthenticated: true,
    });
    render(<PasswordSignInForm navigate={navigate} next="/agents" />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password-here" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("alert");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows the server's reason for a rejected sign-in rather than restating it", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      passwordSignInFails: true,
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password-here" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Uniform by design: the server will not say which of the address or the password was wrong.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The email address or password is incorrect");
  });
});
