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
  fireEvent.change(container.querySelector("input") as HTMLInputElement, { target: { value: repository } });
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
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("acme/second");
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
it("replays uncertainty with the same identity, but uses a new identity for changed revisions or repositories", async () => {
  const operation = vi
    .spyOn(browserApi, "contextTreeOperation")
    .mockResolvedValue({ status: "failed", code: "publication_uncertain" });
  const initial = config();
  const props = { computerName: "Computer", online: true, onChanged: vi.fn() };
  const view = render(<ContextTreeSettings config={initial} {...props} />);
  enter(view.container, "Acme/Memory");
  click(view.container, "Create private repository");
  await screen.findByRole("alert");
  click(view.container, "Create private repository");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
  expect(operation.mock.calls[1]?.[1]).toEqual(operation.mock.calls[0]?.[1]);
  await screen.findByRole("alert");
  view.rerender(
    <ContextTreeSettings
      config={{ ...initial, runtimeConfig: { ...initial.runtimeConfig, revision: 4 } }}
      {...props}
    />,
  );
  click(view.container, "Create private repository");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
  expect(operation.mock.calls[2]?.[1].operationId).not.toBe(operation.mock.calls[0]?.[1].operationId);
  await screen.findByRole("alert");
  enter(view.container, "acme/another");
  click(view.container, "Create private repository");
  await waitFor(() => expect(operation).toHaveBeenCalledTimes(4));
  expect(operation.mock.calls[3]?.[1].repository).toBe("acme/another");
});
