// @vitest-environment jsdom

import { type AgentAdminConfig, CONTEXT_TREES_MAX, type ContextTreeOperationResponse } from "@opentag/shared/browser";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render as renderDom, screen, waitFor, within } from "@testing-library/react";
import { type ReactElement, type ReactNode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { ContextTreeSettings } from "./context-tree-settings.js";

function TestRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) }),
  );
  return <RouterContextProvider router={router as never}>{children}</RouterContextProvider>;
}
function render(ui: ReactElement) {
  return renderDom(ui, { wrapper: TestRouter });
}

function config(id = "agent-a", repository: string | null = null): AgentAdminConfig {
  return {
    id,
    createdByUserId: "user",
    computerId: null,
    name: id,
    displayName: id,
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    selfConfigurationEnabled: false,
    status: "suspended",
    revision: 2,
    runtimeConfig: {
      permissions: { approvalPolicy: "on-request", allowCommands: [] },
      revision: 3,
      contextTrees: repository ? [{ kind: "git", repository, path: ".", ref: "main" }] : [],
      model: null,
      reasoningEffort: null,
      instructions: "",
      maxDurationMs: null,
    },
    createdAt: "2026-09-16T00:00:00Z",
    updatedAt: "2026-09-16T00:00:00Z",
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function openForm(mode: "connect" | "create" = "connect") {
  const name = mode === "connect" ? "Connect Context Tree" : "Create Context Tree";
  const button = screen.queryByRole("button", { name });
  if (button) fireEvent.click(button);
  else {
    fireEvent.click(screen.getByRole("button", { name: "Connect another Context Tree" }));
    const directDialog = screen.queryByRole("dialog", { name });
    if (directDialog) return directDialog;
    fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) }));
  }
  return screen.findByRole("dialog", { name });
}
function enter(repository = "acme/memory") {
  const link = screen.queryByRole("textbox", { name: "GitHub repository link" });
  if (link) {
    fireEvent.change(link, { target: { value: `https://github.com/${repository}` } });
    return;
  }
  const [owner, name] = repository.split("/");
  fireEvent.change(screen.getByRole("textbox", { name: "GitHub owner" }), { target: { value: owner } });
  fireEvent.change(screen.getByRole("textbox", { name: "Repository name" }), { target: { value: name } });
}
function submit(mode: "connect" | "create" = "connect") {
  fireEvent.click(screen.getByRole("button", { name: mode === "connect" ? "Connect" : "Create and connect" }));
}

it("starts with two clear choices and opens only the chosen form, returning focus on cancel", async () => {
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "No Context Trees yet" })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add tree" })).toBeNull();
  const trigger = screen.getByRole("button", { name: "Create Context Tree" });
  trigger.focus();
  const dialog = await openForm("create");
  expect(within(dialog).getByText(/new private repository/)).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Directory (leave empty for root)" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("connects a repository link and directory using the default branch, then refreshes the selection", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: "acme/memory" });
  const changed = vi.fn();
  render(<ContextTreeSettings config={config()} online onChanged={changed} />);
  await openForm();
  enter();
  expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Directory (leave empty for root)" }), {
    target: { value: "docs/guide" },
  });
  submit();
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(operation).toHaveBeenCalledWith(
    "agent-a",
    expect.objectContaining({ action: "connect", repository: "acme/memory", path: "docs/guide", ref: "HEAD" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("accepts a clone URL and leaves the directory empty for the root", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: "acme/memory", ref: "trunk" });
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm();
  fireEvent.change(screen.getByRole("textbox", { name: "GitHub repository link" }), {
    target: { value: "https://github.com/acme/memory.git" },
  });
  expect((screen.getByRole("textbox", { name: "Directory (leave empty for root)" }) as HTMLInputElement).value).toBe(
    "",
  );
  submit();
  await waitFor(() =>
    expect(operation).toHaveBeenCalledWith(
      "agent-a",
      expect.objectContaining({ repository: "acme/memory", path: ".", ref: "HEAD" }),
    ),
  );
});

it("renders source cards with exact GitHub links and disconnects only the chosen source while offline", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: null });
  const current = config("agent-a", "acme/memory");
  current.runtimeConfig.contextTrees.push({
    kind: "git",
    repository: "acme/project",
    path: "docs/my guide",
    ref: "feature/docs",
  });
  render(<ContextTreeSettings config={current} online={false} onChanged={vi.fn()} />);
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("link", { name: "Open my guide on GitHub" }).getAttribute("href")).toBe(
    "https://github.com/acme/project/tree/feature%2Fdocs/docs/my%20guide",
  );
  fireEvent.click(screen.getByRole("button", { name: "More actions for my guide" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  expect(operation).not.toHaveBeenCalled();
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
  await waitFor(() =>
    expect(operation).toHaveBeenCalledWith(
      "agent-a",
      expect.objectContaining({
        action: "disconnect",
        repository: "acme/project",
        path: "docs/my guide",
        ref: "feature/docs",
      }),
    ),
  );
});

it.each([null, "acme/existing"])("creates a Cloud tree with existing selection %s", async (repository) => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: "acme/memory", ref: "trunk" });
  const changed = vi.fn();
  render(
    <ContextTreeSettings config={config("agent-a", repository)} computerKind="cloud" online onChanged={changed} />,
  );
  const dialog = await openForm("create");
  expect(within(dialog).getByText(/new private repository/)).toBeTruthy();
  expect(within(dialog).getByText("Manage GitHub authorization in Account settings.")).toBeTruthy();
  enter();
  submit("create");
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(operation).toHaveBeenCalledExactlyOnceWith("agent-a", {
    action: "create",
    kind: "git",
    repository: "acme/memory",
    path: ".",
    ref: "HEAD",
    expectedRevision: 2,
    expectedRuntimeConfigRevision: 3,
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("hides the secondary connection action when the Context Tree limit is reached", () => {
  const current = config();
  current.runtimeConfig.contextTrees = Array.from({ length: CONTEXT_TREES_MAX }, (_, index) => ({
    kind: "git",
    repository: `acme/memory-${index}`,
    path: ".",
    ref: "main",
  }));
  render(<ContextTreeSettings config={current} online onChanged={vi.fn()} />);
  expect(screen.getAllByRole("article")).toHaveLength(CONTEXT_TREES_MAX);
  expect(screen.queryByRole("button", { name: "Connect another Context Tree" })).toBeNull();
});

it("restores focus to a surviving row action when the final connection removes the trailing action", async () => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({
    status: "completed",
    repository: "acme/final-memory",
  });
  const initial = config();
  initial.runtimeConfig.contextTrees = Array.from({ length: CONTEXT_TREES_MAX - 1 }, (_, index) => ({
    kind: "git" as const,
    repository: `acme/memory-${index}`,
    path: ".",
    ref: "main",
  }));
  const changed = vi.fn();
  const view = render(<ContextTreeSettings config={initial} online onChanged={changed} />);
  await openForm();
  enter("acme/final-memory");
  submit();
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());

  const updated = structuredClone(initial);
  updated.runtimeConfig.contextTrees.push({
    kind: "git",
    repository: "acme/final-memory",
    path: ".",
    ref: "main",
  });
  view.rerender(<ContextTreeSettings config={updated} online onChanged={vi.fn()} />);

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const survivingAction = screen.getByRole("button", { name: `More actions for memory-${CONTEXT_TREES_MAX - 2}` });
  await waitFor(() => expect(document.activeElement).toBe(survivingAction));
  expect(screen.queryByRole("button", { name: "Connect another Context Tree" })).toBeNull();
});

it("explains offline and pause restrictions without blocking source browsing", async () => {
  const view = render(<ContextTreeSettings config={config()} online={false} onChanged={vi.fn()} />);
  await openForm();
  expect(within(screen.getByRole("dialog")).getByText(/Bring the Computer online/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(
    <ContextTreeSettings config={{ ...config("agent-b", "acme/tree"), status: "active" }} online onChanged={vi.fn()} />,
  );
  expect(screen.getByText(/Pause this Agent/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect another Context Tree" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByRole("link", { name: "Open tree on GitHub" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More actions for tree" }));
  expect((await screen.findByRole("menuitem", { name: "Disconnect" })).getAttribute("aria-disabled")).toBe("true");
});

it("validates the fields and focuses the first invalid input without contacting the server", async () => {
  const operation = vi.spyOn(browserApi, "contextTreeOperation");
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm();
  submit();
  const link = screen.getByRole("textbox", { name: "GitHub repository link" });
  expect(document.activeElement).toBe(link);
  expect(link.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(link, { target: { value: "https://example.com/acme/memory" } });
  submit();
  expect(link.getAttribute("aria-invalid")).toBe("true");
  enter();
  fireEvent.change(screen.getByRole("textbox", { name: "Directory (leave empty for root)" }), {
    target: { value: "../outside" },
  });
  submit();
  const directory = screen.getByRole("textbox", { name: "Directory (leave empty for root)" });
  expect(document.activeElement).toBe(directory);
  expect(directory.getAttribute("aria-invalid")).toBe("true");
  expect(directory.getAttribute("aria-describedby")).toContain("path-error");
  expect(operation).not.toHaveBeenCalled();
});

it("keeps an uncertain creation open and creates at the repository root", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "failed", code: "publication_uncertain" });
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm("create");
  enter("  Acme  /  New-Memory  ");
  submit("create");
  await screen.findByRole("alert");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(operation.mock.calls[0]?.[1]).toMatchObject({
    action: "create",
    repository: "Acme/New-Memory",
    path: ".",
    ref: "HEAD",
  });
});

it.each([
  ["authentication_required", /Connect or reconnect GitHub/],
  ["permission_denied", /GitHub denied access/],
  ["capability_missing", /Update openTag on the bound computer/],
  ["github_not_configured", /GitHub isn't configured on this openTag server/],
  ["tree_limit_reached", /maximum number of Context Trees/],
  ["invalid_tree", /Remove symlinks such as CLAUDE.md or README.md/],
  ["repository_rejected", /may already exist/],
  ["publication_uncertain", /Check the repository before creating again/],
] as const)("explains %s in the form's error banner", async (code, message) => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({ status: "failed", code });
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm();
  enter();
  submit();
  expect((await screen.findByRole("alert")).textContent).toMatch(message);
  if (code === "authentication_required") {
    const settings = screen.getByRole("link", { name: "Account settings" });
    expect(settings.getAttribute("href")).toBe("/account");
    expect(settings.getAttribute("target")).toBe("_blank");
  }
});

it.each(["agent", "revision"])("ignores pending responses after a change of %s", async (change) => {
  let resolve!: (value: ContextTreeOperationResponse) => void;
  vi.spyOn(browserApi, "contextTreeOperation").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const changed = vi.fn();
  const initial = config();
  const view = render(<ContextTreeSettings config={initial} online onChanged={changed} />);
  await openForm();
  enter();
  submit();
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(
    <ContextTreeSettings
      config={change === "agent" ? config("agent-b") : { ...initial, revision: 4 }}
      online
      onChanged={changed}
    />,
  );
  await act(async () => resolve({ status: "completed", repository: "acme/memory" }));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByText("Context Tree settings saved.")).toBeNull();
});

it("retains an uncertain creation that resolves after a config revision change", async () => {
  let resolve!: (value: ContextTreeOperationResponse) => void;
  const operation = vi.spyOn(browserApi, "contextTreeOperation").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const changed = vi.fn();
  const initial = config();
  const view = render(<ContextTreeSettings config={initial} online onChanged={changed} />);
  await openForm("create");
  enter("acme/revision-race");
  submit("create");

  view.rerender(<ContextTreeSettings config={{ ...initial, revision: 4 }} online onChanged={changed} />);
  await act(async () => resolve({ status: "failed", code: "publication_uncertain" }));

  const create = screen.getByRole("button", { name: "Create and connect" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/Check the repository before creating again/);
  fireEvent.click(create);
  expect(operation).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
});

it("confirms the exact source, initially focuses Cancel and sends nothing on cancel", async () => {
  const operation = vi.spyOn(browserApi, "contextTreeOperation");
  render(<ContextTreeSettings config={config("agent-a", "acme/memory")} online onChanged={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "More actions for memory" });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("acme/memory")).toBeTruthy();
  expect(within(dialog).getByText(/unpublished work are preserved/)).toBeTruthy();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  fireEvent.click(cancel);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(operation).not.toHaveBeenCalled();
});

it("blocks duplicate disconnects, preserves a refused confirmation and returns focus on cancel", async () => {
  let finish!: (result: ContextTreeOperationResponse) => void;
  const operation = vi.spyOn(browserApi, "contextTreeOperation").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<ContextTreeSettings config={config("agent-a", "acme/memory")} online onChanged={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "More actions for memory" });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  const dialog = screen.getByRole("alertdialog");
  const submit = within(dialog).getByRole("button", { name: "Disconnect" });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(operation).toHaveBeenCalledOnce();
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByText("Disconnecting…")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await act(async () => finish({ status: "failed", code: "failed" }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("focuses the trailing collection action after the first successful connection", async () => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({ status: "completed", repository: "acme/memory" });
  const initial = config();
  const view = render(<ContextTreeSettings config={initial} online onChanged={vi.fn()} />);
  await openForm();
  enter();
  submit();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  view.rerender(<ContextTreeSettings config={config("agent-a", "acme/memory")} online onChanged={vi.fn()} />);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect another Context Tree" })),
  );
  expect(screen.getByRole("status").textContent).toBe("Context Tree settings saved.");
});

it.each([false, true])("restores a surviving target after disconnect; neighbour=%s", async (hasNeighbour) => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({ status: "completed", repository: null });
  const initial = config("agent-a", "acme/memory");
  if (hasNeighbour)
    initial.runtimeConfig.contextTrees.push({ kind: "git", repository: "acme/next", path: ".", ref: "main" });
  const view = render(<ContextTreeSettings config={initial} online onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "More actions for memory" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  const updated = config("agent-a", hasNeighbour ? "acme/next" : null);
  view.rerender(<ContextTreeSettings config={updated} online onChanged={vi.fn()} />);
  const target = screen.getByRole("button", {
    name: hasNeighbour ? "More actions for next" : "Connect Context Tree",
  });
  await waitFor(() => expect(document.activeElement).toBe(target));
});

it("focuses a recovered connection and clears the uncertain lock after it succeeds", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValueOnce({ status: "failed", code: "publication_uncertain" })
    .mockResolvedValueOnce({ status: "completed", repository: "Acme/Memory" });
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm("create");
  enter("Acme/Memory");
  submit("create");
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "Create and connect" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("link", { name: "Open repository" }).getAttribute("href")).toBe(
    "https://github.com/Acme/Memory",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "GitHub owner" }), { target: { value: "acme" } });
  expect((screen.getByRole("button", { name: "Create and connect" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await openForm("create");
  expect((screen.getByRole("button", { name: "Create and connect" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Connect existing" }));
  const repository = screen.getByRole("textbox", { name: "GitHub repository link" });
  expect((repository as HTMLInputElement).value).toBe("https://github.com/Acme/Memory");
  await waitFor(() => expect(document.activeElement).toBe(repository));
  expect((screen.getByRole("textbox", { name: "Directory (leave empty for root)" }) as HTMLInputElement).value).toBe(
    "",
  );
  submit();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(operation).toHaveBeenCalledTimes(2);
  await openForm("create");
  expect((screen.getByRole("button", { name: "Create and connect" }) as HTMLButtonElement).disabled).toBe(false);
});

it("retains every unresolved creation identity when attempts fail for different repositories", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "failed", code: "publication_uncertain" });
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm("create");

  enter("acme/first-uncertain");
  submit("create");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));

  enter("acme/second-uncertain");
  submit("create");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));

  enter("ACME/FIRST-UNCERTAIN");
  expect(await screen.findByRole("alert")).toBeTruthy();
  const create = screen.getByRole("button", { name: "Create and connect" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(create);
  expect(operation).toHaveBeenCalledTimes(2);
});

it("explains both restrictions when active and offline without claiming disconnect is available", () => {
  render(
    <ContextTreeSettings
      config={{ ...config("agent-a", "acme/memory"), status: "active" }}
      online={false}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText(/Pause this Agent/)).toBeTruthy();
  expect(screen.getByText(/Bring the Computer online/)).toBeTruthy();
  expect(screen.queryByText(/Disconnect remains available/)).toBeNull();
  expect(screen.getByRole("link", { name: "Manage Agent" }).getAttribute("href")).toBe(
    "/agents/agent-a/settings/manage",
  );
});

it("preserves a form draft but disables writes while the current selection is unconfirmed", async () => {
  const current = config();
  const operation = vi.spyOn(browserApi, "contextTreeOperation");
  const view = render(<ContextTreeSettings config={current} online onChanged={vi.fn()} />);
  await openForm();
  enter();
  view.rerender(<ContextTreeSettings config={current} online unconfirmed onChanged={vi.fn()} />);
  expect((screen.getByRole("textbox", { name: "GitHub repository link" }) as HTMLInputElement).value).toBe(
    "https://github.com/acme/memory",
  );
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  submit();
  expect(operation).not.toHaveBeenCalled();
});
