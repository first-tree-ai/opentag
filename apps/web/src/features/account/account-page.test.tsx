import type { MeResponse } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import * as locale from "../../i18n/locale.js";
import { AccountSettings } from "./account-page.js";
import { GitHubIntegrationSettings } from "./github-integration-settings.js";

const user: MeResponse["user"] = {
  id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  email: "tester@company.example",
  displayName: "Tester",
};

describe("AccountSettings language selector", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders every locale with its self-named label and selects the current locale", async () => {
    render(<AccountSettings refreshMe={vi.fn().mockResolvedValue({ user, setupCompletedAt: null })} user={user} />);

    const selector = screen.getByRole("combobox", { name: "Language" });
    expect(selector.textContent).toContain(locale.LOCALE_LABELS[locale.getLocale()]);
    expect(selector.className.split(/\s+/)).toContain("w-full");
    expect(selector.className.split(/\s+/)).not.toContain("w-max");
    expect(selector.getAttribute("aria-labelledby")).toBe("account-language-label");
    expect(selector.getAttribute("aria-label")).toBeNull();
    expect(selector.closest('[data-ui="field"]')?.querySelector("label")?.classList.contains("sr-only")).toBe(true);

    fireEvent.click(selector);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent?.trim())).toEqual(
      locale.locales.map((availableLocale) => locale.LOCALE_LABELS[availableLocale]),
    );
    const currentOption = options.find(
      (option) => option.textContent?.trim() === locale.LOCALE_LABELS[locale.getLocale()],
    );
    expect(currentOption?.getAttribute("aria-selected")).toBe("true");
  });

  it("passes a normalized locale to Paraglide when the selection changes", async () => {
    const setLocale = vi.spyOn(locale, "setLocale");
    render(<AccountSettings refreshMe={vi.fn().mockResolvedValue({ user, setupCompletedAt: null })} user={user} />);

    const selector = screen.getByRole("combobox", { name: "Language" });
    fireEvent.click(selector);
    const option = await screen.findByRole("option", { name: locale.LOCALE_LABELS.zh });
    fireEvent.pointerMove(option, { pointerType: "mouse" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.pointerUp(option, { pointerType: "mouse" });
    fireEvent.click(option);

    await waitFor(() => expect(setLocale).toHaveBeenCalledWith("zh"));
  });
});

describe("Account profile authorization drafts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("restores a draft after a document round trip without submitting a profile write", async () => {
    const guard = { current: null as (() => void) | null };
    const refresh = vi.fn();
    const first = render(<AccountSettings navigationGuardRef={guard} refreshMe={refresh} user={user} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Unsaved name" } });
    guard.current?.();
    first.unmount();
    render(<AccountSettings refreshMe={refresh} user={user} />);
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Unsaved name");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("opentag.account-profile-navigation-draft")).toBeNull();
  });

  it("does not restore an abandoned edit after authorization fails before navigation", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue({
      availability: { available: true, githubHost: "github.com", oauthClientId: "871235" },
      connection: null,
    });
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new Error("Authorization start failed"));
    const guard = { current: null as (() => void) | null };
    const first = render(
      <>
        <AccountSettings navigationGuardRef={guard} refreshMe={vi.fn()} user={user} />
        <GitHubIntegrationSettings beforeAuthorize={() => guard.current?.()} />
      </>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Abandoned edit" } });
    fireEvent.click(await screen.findByRole("button", { name: "Authorize GitHub account" }));
    await screen.findByText("Authorization start failed");
    fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), { target: { value: user.displayName } });
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    first.unmount();
    render(<AccountSettings refreshMe={vi.fn()} user={user} />);
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe(user.displayName);
    expect(window.sessionStorage.getItem("opentag.account-profile-navigation-draft")).toBeNull();
  });

  it.each(["other-account", "changed-profile", "expired", "future", "malformed"] as const)(
    "does not restore a %s draft",
    (reason) => {
      const draft = {
        accountId: reason === "other-account" ? "another-id" : user.id,
        confirmedName: reason === "changed-profile" ? "An old name" : user.displayName,
        displayName: "Stale private name",
        createdAt:
          reason === "expired" ? Date.now() - 31 * 60_000 : reason === "future" ? Date.now() + 60_000 : Date.now(),
      };
      window.sessionStorage.setItem(
        "opentag.account-profile-navigation-draft",
        reason === "malformed" ? "{bad" : JSON.stringify(draft),
      );
      render(<AccountSettings refreshMe={vi.fn()} user={user} />);
      expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe(user.displayName);
      expect(window.sessionStorage.getItem("opentag.account-profile-navigation-draft")).toBeNull();
    },
  );

  it("keeps edits on screen and prevents navigation when tab storage fails", () => {
    const guard = { current: null as (() => void) | null };
    render(<AccountSettings navigationGuardRef={guard} refreshMe={vi.fn()} user={user} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Keep this draft" } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage disabled");
    });
    expect(() => guard.current?.()).toThrow("Save or discard the edit before authorizing GitHub.");
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(() => guard.current?.()).not.toThrow();
  });
});
