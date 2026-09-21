// @vitest-environment jsdom

import type { AgentAdminConfig, ContextTreeOperationResponse } from "@opentag/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    status: "suspended",
    revision: 2,
    runtimeConfig: {
      revision: 3,
      contextTreeRepository: repository,
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
function enter(container: HTMLElement, repository: string) {
  const [owner, name] = repository.split("/");
  const inputs = container.querySelectorAll("input");
  fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: owner } });
  fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: name } });
}
function click(container: HTMLElement, name: string) {
  fireEvent.click(
    [...container.querySelectorAll("button")].find((button) => button.textContent === name) as HTMLButtonElement,
  );
}
it("resets cached form state on Agent switching and ignores the previous Agent response", async () => {
  let resolve!: (value: ContextTreeOperationResponse) => void;
  vi.spyOn(browserApi, "contextTreeOperation").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const onChanged = vi.fn();
  const view = render(<ContextTreeSettings config={config()} computerName="Computer" online onChanged={onChanged} />);
  enter(view.container, "acme/first");
  click(view.container, "Connect");
  view.rerender(
    <ContextTreeSettings
      config={config("agent-b", "acme/second")}
      computerName="Computer"
      online
      onChanged={onChanged}
    />,
  );
  expect((screen.getByRole("textbox", { name: "GitHub owner" }) as HTMLInputElement).value).toBe("acme");
  expect((screen.getByRole("textbox", { name: "Repository name" }) as HTMLInputElement).value).toBe("second");
  await act(async () => resolve({ status: "failed", code: "publication_uncertain" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false);
});
it("disconnects an offline, unbound Agent", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: null });
  render(
    <ContextTreeSettings
      config={config("agent-a", "acme/memory")}
      computerName="Computer"
      online={false}
      onChanged={vi.fn()}
    />,
  );
  click(
    screen.getByRole("heading", { name: "Context Tree" }).parentElement?.parentElement as HTMLElement,
    "Disconnect",
  );
  await waitFor(() =>
    expect(operation).toHaveBeenCalledWith(
      "agent-a",
      expect.objectContaining({ action: "disconnect", repository: null }),
    ),
  );
});
it("hides Create for a Cloud Agent, connects an existing Tree, and points at integration authorization", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "completed", repository: "acme/memory" });
  const onChanged = vi.fn();
  const view = render(
    <ContextTreeSettings config={config()} computerName="Computer" computerKind="cloud" online onChanged={onChanged} />,
  );
  expect(screen.queryByRole("button", { name: "Create new" })).toBeNull();
  expect(screen.getByText(/Integrations/i)).toBeTruthy();
  enter(view.container, "acme/memory");
  click(view.container, "Connect");
  await waitFor(() =>
    expect(operation).toHaveBeenCalledWith(
      "agent-a",
      expect.objectContaining({ action: "connect", repository: "acme/memory" }),
    ),
  );
  expect(onChanged).toHaveBeenCalled();
});
it("guides a Cloud authentication failure to GitHub integrations, not the local computer", async () => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({
    status: "failed",
    code: "authentication_required",
  });
  const view = render(
    <ContextTreeSettings config={config()} computerName="Computer" computerKind="cloud" online onChanged={vi.fn()} />,
  );
  enter(view.container, "acme/memory");
  click(view.container, "Connect");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/Integrations/i);
  expect(alert.textContent).not.toMatch(/gh auth login/i);
});
it("guides Cloud permission and preparation failures to Integrations instead of local advice", async () => {
  const operation = vi.spyOn(browserApi, "contextTreeOperation");
  const view = render(
    <ContextTreeSettings config={config()} computerName="Computer" computerKind="cloud" online onChanged={vi.fn()} />,
  );
  enter(view.container, "acme/memory");
  operation.mockResolvedValue({ status: "failed", code: "permission_denied" });
  click(view.container, "Connect");
  const denied = await screen.findByRole("alert");
  expect(denied.textContent).toMatch(/Integrations/i);
  expect(denied.textContent).not.toMatch(/computer/i);
  operation.mockResolvedValue({ status: "failed", code: "failed" });
  click(view.container, "Connect");
  const failed = await screen.findByRole("alert");
  expect(failed.textContent).toMatch(/Integrations/i);
  expect(failed.textContent).not.toMatch(/computer and repository/i);
});
it("keeps Local permission and preparation failure advice unchanged", async () => {
  const operation = vi.spyOn(browserApi, "contextTreeOperation");
  const view = render(<ContextTreeSettings config={config()} computerName="Computer" online onChanged={vi.fn()} />);
  enter(view.container, "acme/memory");
  operation.mockResolvedValue({ status: "failed", code: "permission_denied" });
  click(view.container, "Connect");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "GitHub denied access. Check repository and organization permissions.",
  );
  operation.mockResolvedValue({ status: "failed", code: "failed" });
  click(view.container, "Connect");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Context Tree preparation failed. Check the computer and repository, then retry.",
  );
});
it("keeps Local create and local authentication guidance unchanged", async () => {
  const operation = vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({
    status: "failed",
    code: "authentication_required",
  });
  const view = render(<ContextTreeSettings config={config()} computerName="Computer" online onChanged={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Create new" })).toBeTruthy();
  expect(screen.queryByText(/Integrations/i)).toBeNull();
  enter(view.container, "acme/memory");
  click(view.container, "Connect");
  expect((await screen.findByRole("alert")).textContent).toBe("Run gh auth login on Computer, then retry.");
  expect(operation).toHaveBeenCalledWith("agent-a", expect.objectContaining({ action: "connect" }));
});
it("keeps the Local capability guidance unchanged", async () => {
  vi.spyOn(browserApi, "contextTreeOperation").mockResolvedValue({ status: "failed", code: "capability_missing" });
  const view = render(<ContextTreeSettings config={config()} computerName="Computer" online onChanged={vi.fn()} />);
  click(view.container, "Create new");
  enter(view.container, "acme/memory");
  click(view.container, "Create and connect");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Update OpenTag on the bound computer to use Context Tree settings.",
  );
});
it("replays uncertainty with the same identity, but uses a new identity for changed revisions or repositories", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "failed", code: "publication_uncertain" });
  const initial = config();
  const props = { computerName: "Computer", online: true, onChanged: vi.fn() };
  const view = render(<ContextTreeSettings config={initial} {...props} />);
  click(view.container, "Create new");
  enter(view.container, "Acme/Memory");
  click(view.container, "Create and connect");
  await screen.findByRole("alert");
  click(view.container, "Create and connect");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
  expect(operation.mock.calls[1]?.[1]).toEqual(operation.mock.calls[0]?.[1]);
  await screen.findByRole("alert");
  view.rerender(
    <ContextTreeSettings
      config={{ ...initial, runtimeConfig: { ...initial.runtimeConfig, revision: 4 } }}
      {...props}
    />,
  );
  click(view.container, "Create and connect");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
  expect(operation.mock.calls[2]?.[1].operationId).not.toBe(operation.mock.calls[0]?.[1].operationId);
  await screen.findByRole("alert");
  enter(view.container, "acme/another");
  click(view.container, "Create and connect");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(4));
  expect(operation.mock.calls[3]?.[1].repository).toBe("acme/another");
});

it("validates incomplete and invalid fields on submit and focuses the first error", () => {
  const operation = vi.spyOn(browserApi, "contextTreeOperation");
  const view = render(<ContextTreeSettings config={config()} computerName="Computer" online onChanged={vi.fn()} />);
  const owner = screen.getByRole("textbox", { name: "GitHub owner" });
  const name = screen.getByRole("textbox", { name: "Repository name" });
  expect(screen.getByText("Not connected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  click(view.container, "Connect");
  expect(document.activeElement).toBe(owner);
  expect(owner.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById("context-tree-agent-a-owner-error")?.textContent).toMatch(/Enter a valid/);
  expect(owner.getAttribute("aria-describedby")).toContain("context-tree-agent-a-owner-error");
  fireEvent.change(owner, { target: { value: "acme" } });
  click(view.container, "Connect");
  expect(document.activeElement).toBe(name);
  for (const invalid of ["repo.git", "a/b", "-repo", "bad name"]) {
    fireEvent.change(name, { target: { value: invalid } });
    click(view.container, "Connect");
    expect(name.getAttribute("aria-invalid")).toBe("true");
  }
  enter(view.container, "bad owner/memory");
  click(view.container, "Connect");
  expect(document.activeElement).toBe(owner);
  expect(operation).not.toHaveBeenCalled();
});

it("preserves separate drafts, clears mode errors and results, and composes trimmed payloads", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "failed", code: "publication_uncertain" });
  const view = render(
    <ContextTreeSettings
      config={config("agent-a", "acme/existing")}
      computerName="Computer"
      online
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText("Connected to acme/existing")).toBeTruthy();
  click(view.container, "Create new");
  expect((screen.getByRole("textbox", { name: "GitHub owner" }) as HTMLInputElement).value).toBe("");
  click(view.container, "Create and connect");
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  click(view.container, "Connect existing");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("github.com/acme/existing")).toBeTruthy();
  click(view.container, "Create new");
  enter(view.container, "  Acme  /  New-Memory  ");
  expect(screen.getByText("github.com/Acme/New-Memory")).toBeTruthy();
  click(view.container, "Create and connect");
  await screen.findByRole("alert");
  expect(operation).toHaveBeenCalledWith(
    "agent-a",
    expect.objectContaining({ action: "create", repository: "Acme/New-Memory" }),
  );
  click(view.container, "Connect existing");
  expect(screen.queryByRole("alert")).toBeNull();
  click(view.container, "Create new");
  expect(screen.getByText("github.com/Acme/New-Memory")).toBeTruthy();
  click(view.container, "Create and connect");
  await screen.findByRole("alert");
  expect(operation.mock.calls[1]?.[1]).toEqual(operation.mock.calls[0]?.[1]);
});

it("explains offline and pause restrictions while leaving mode selection available", () => {
  const props = { computerName: "Computer", onChanged: vi.fn() };
  const view = render(<ContextTreeSettings config={config()} {...props} online={false} />);
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Bring the Computer online/)).toBeTruthy();
  click(view.container, "Create new");
  expect((screen.getByRole("button", { name: "Create and connect" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(
    <ContextTreeSettings config={{ ...config("agent-b", "acme/tree"), status: "active" }} {...props} online />,
  );
  expect(screen.getByText(/Pause this Agent/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(true);
});

it("ignores responses after the same Agent revision changes", async () => {
  let resolve!: (value: ContextTreeOperationResponse) => void;
  vi.spyOn(browserApi, "contextTreeOperation").mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const onChanged = vi.fn();
  const initial = config();
  const view = render(<ContextTreeSettings config={initial} computerName="Computer" online onChanged={onChanged} />);
  enter(view.container, "acme/tree");
  click(view.container, "Connect");
  view.rerender(
    <ContextTreeSettings config={{ ...initial, revision: 4 }} computerName="Computer" online onChanged={onChanged} />,
  );
  await act(async () => resolve({ status: "completed", repository: "acme/tree" }));
  expect(screen.queryByText("Context Tree settings saved.")).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
});
