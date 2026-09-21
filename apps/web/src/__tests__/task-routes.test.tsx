import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { installApi, resetWebAppState, taskSessionId } from "./support/app-fixtures.js";

const exampleTaskId = "10000000-0000-4000-8000-000000000001";
const exampleTaskTitle = "Review Q3 launch readiness and flag unowned work";

/**
 * The workspace-level Task routes are a development-only preview over local example data. In
 * production builds they hand the reader straight back to the Agents list instead of rendering a
 * surface the Server cannot back.
 */
describe("workspace Task routes", () => {
  beforeEach(resetWebAppState);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists the local example Tasks at /tasks in development", async () => {
    installApi();
    window.history.replaceState({}, "", "/tasks");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: exampleTaskTitle })).toBeTruthy();
    expect(window.location.pathname).toBe("/tasks");
  });

  it.each([
    ["a boolean flag", `/tasks/${exampleTaskId}?examples=true`],
    ["a string flag", `/tasks/${exampleTaskId}?examples=%22true%22`],
  ])("opens a local example Task detail when the search carries %s", async (_label, path) => {
    installApi();
    window.history.replaceState({}, "", path);
    render(<App />);

    expect(await screen.findByRole("heading", { name: exampleTaskTitle })).toBeTruthy();
    expect(window.location.pathname).toBe(`/tasks/${exampleTaskId}`);
  });

  it.each([
    ["without the examples flag", `/tasks/${taskSessionId}`],
    ["with an unrecognised examples value", `/tasks/${taskSessionId}?examples=1`],
  ])("returns a Task detail %s to the Agents list", async (_label, path) => {
    installApi();
    window.history.replaceState({}, "", path);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "All Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it.each(["/tasks", `/tasks/${exampleTaskId}?examples=true`])(
    "returns %s to the Agents list outside development",
    async (path) => {
      vi.stubEnv("DEV", false);
      installApi();
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "All Agents" })).toBeTruthy();
      expect(window.location.pathname).toBe("/agents");
    },
  );
});
