import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { agentId, installApi, resetWebAppState } from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("opens the Agent's Context Tree from its own navigation entry, outside Settings", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/context-tree`);
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Context Tree" })).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
    const navigation = await screen.findByRole("navigation", { name: "Agent" });
    const entry = within(navigation).getByRole("link", { name: "Context Tree" });
    expect(entry.getAttribute("href")).toBe(`/agents/${agentId}/context-tree`);
    expect(entry.getAttribute("aria-current")).toBe("page");
  });
});
