// @vitest-environment jsdom

import type { AgentAdminConfig, ContextTreeOperationResponse } from "@opentag/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { ContextTreeSettings } from "./context-tree-settings.js";

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
    fireEvent.click(screen.getByRole("button", { name: "Add tree" }));
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
  expect(screen.getByRole("heading", { name: "Add a Context Tree" })).toBeTruthy();
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

it.each(["local", "cloud"] as const)("connects a %s tree directory using the default branch", async (computerKind) => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: "acme/memory" });
  const changed = vi.fn();
  render(<ContextTreeSettings config={config()} computerKind={computerKind} online onChanged={changed} />);
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

it("explains offline and pause restrictions without blocking source browsing", async () => {
  const view = render(<ContextTreeSettings config={config()} online={false} onChanged={vi.fn()} />);
  await openForm();
  expect(screen.getByText(/Bring the Computer online/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(
    <ContextTreeSettings config={{ ...config("agent-b", "acme/tree"), status: "active" }} online onChanged={vi.fn()} />,
  );
  expect(screen.getByText(/Pause this Agent/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add tree" }) as HTMLButtonElement).disabled).toBe(true);
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
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Directory (leave empty for root)" }));
  expect(operation).not.toHaveBeenCalled();
});

it.each(["local", "cloud"] as const)(
  "keeps an uncertain %s creation open at the repository root",
  async (computerKind) => {
    const operation = vi
      .spyOn(browserApi, "contextTreeOperation")
      .mockResolvedValue({ status: "failed", code: "publication_uncertain" });
    render(<ContextTreeSettings config={config()} computerKind={computerKind} online onChanged={vi.fn()} />);
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
  },
);

it.each([
  ["authentication_required", /Connect or reconnect GitHub/],
  ["permission_denied", /GitHub denied access/],
  ["capability_missing", /Update openTag on the bound computer/],
  ["github_not_configured", /GitHub isn't configured on this openTag server/],
  ["tree_limit_reached", /maximum number of Context Trees/],
  ["invalid_tree", /Remove symlinks such as CLAUDE.md or README.md/],
  ["repository_rejected", /may already exist/],
  ["publication_uncertain", /If it is empty, initialize it/],
] as const)("explains %s in the form's error banner", async (code, message) => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({ status: "failed", code });
  render(<ContextTreeSettings config={config()} online onChanged={vi.fn()} />);
  await openForm();
  enter();
  submit();
  expect((await screen.findByRole("alert")).textContent).toMatch(message);
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
