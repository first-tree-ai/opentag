import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("opens the Agent's Context Tree from its own navigation entry, outside Settings", async () => {
    installApi({ bound: true });
    const oldAuthorization = vi.spyOn(browserApi, "githubIntegration").mockRejectedValue(new Error("Retired"));
    window.history.replaceState({}, "", `/agents/${agentId}/context-tree`);
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
    const navigation = await screen.findByRole("navigation", { name: "Agent" });
    const entry = within(navigation).getByRole("link", { name: "Memory" });
    expect(entry.getAttribute("href")).toBe(`/agents/${agentId}/context-tree`);
    expect(entry.getAttribute("aria-current")).toBe("page");
    expect(oldAuthorization).not.toHaveBeenCalled();
  });

  it("removes the independent GitHub section and queries from Account", async () => {
    installApi({ bound: true });
    const oldAuthorization = vi.spyOn(browserApi, "githubIntegration").mockRejectedValue(new Error("Retired"));
    window.history.replaceState({}, "", "/account");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Account" })).toBeTruthy();
    expect(screen.queryByText("Context Tree GitHub")).toBeNull();
    expect(screen.queryByRole("button", { name: "Authorize GitHub account" })).toBeNull();
    expect(oldAuthorization).not.toHaveBeenCalled();
  });
});
