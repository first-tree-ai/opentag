import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { browserApi } from "../../api.js";
import { LoginPage } from "./login-page.js";

describe("LoginPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("separates password sign-in from external providers", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({
      providers: [
        { id: "password", enabled: true, startUrl: null },
        { id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" },
      ],
    });
    await renderInRouter(<LoginPage next="/agents" />);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(screen.getByText("or")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toBeTruthy();
  });

  it("explains when no enabled provider is available", async () => {
    vi.spyOn(browserApi, "authProviders").mockResolvedValue({
      providers: [{ id: "password", enabled: false, startUrl: null }],
    });
    await renderInRouter(<LoginPage />);
    expect(await screen.findByText("No sign-in methods are currently available.")).toBeTruthy();
  });
});
