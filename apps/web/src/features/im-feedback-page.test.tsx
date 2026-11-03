import type { ImFeedbackView } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { ImFeedbackPage } from "./im-feedback-page.js";

const ID = "11111111-1111-4111-8111-111111111111";
const view = (overrides: Partial<ImFeedbackView> = {}): ImFeedbackView => ({
  id: ID,
  agentId: "22222222-2222-4222-8222-222222222222",
  taskId: "55555555-5555-4555-8555-555555555555",
  sessionId: "33333333-3333-4333-8333-333333333333",
  revision: 2,
  state: "workspace_blocked",
  errorCode: "workspace_failed",
  effects: "completed",
  sandboxId: "44444444-4444-4444-8444-444444444444",
  environmentGeneration: 3,
  deliveryState: "sent",
  retryBlockedReason: null,
  actions: [
    { kind: "save_release", confirmation: "save-token" },
    { kind: "discard", confirmation: "discard-token" },
  ],
  action: null,
  ...overrides,
});
function api(data = view()) {
  return {
    imFeedback: vi.fn(async () => data),
    imFeedbackAction: vi.fn(async () =>
      view({
        ...data,
        state: "resolved",
        actions: [],
        action: {
          kind: "save_release",
          state: "succeeded",
          resultCode: "saved_released",
          actorDisplayName: "Alice",
          updatedAt: "2026-11-03T00:00:00Z",
        },
      }),
    ),
  };
}
afterEach(() => {
  overwriteGetLocale(() => "en");
  vi.restoreAllMocks();
});
describe("Account-owned IM recovery", () => {
  it("only reads when a card URL opens, including a discard hint", async () => {
    const client = api();
    await renderInRouter(<ImFeedbackPage feedbackId={ID} operation="discard" api={client} />);
    await screen.findByText("Workspace version 3");
    expect(client.imFeedbackAction).not.toHaveBeenCalled();
  });
  it("links technical details to the original Task", async () => {
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Technical details" }));
    expect((await screen.findByRole("link", { name: "Open Task" })).getAttribute("href")).toBe(
      "/agents/22222222-2222-4222-8222-222222222222/tasks/55555555-5555-4555-8555-555555555555",
    );
  });
  it("requires explicit second confirmation and loss acknowledgement for discard", async () => {
    const client = api();
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard unsaved changes" }));
    expect((screen.getByRole("button", { name: "Confirm operation" }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.imFeedbackAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm operation" }));
    await waitFor(() =>
      expect(client.imFeedbackAction).toHaveBeenCalledExactlyOnceWith(ID, {
        kind: "discard",
        revision: 2,
        confirmation: "discard-token",
        permanentLossAcknowledged: true,
      }),
    );
  });
  it("refreshes and refuses a newer workspace generation before submitting", async () => {
    const client = api();
    client.imFeedback.mockResolvedValueOnce(view()).mockResolvedValue(view({ environmentGeneration: 4 }));
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry save and release" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm operation" }));
    await screen.findByText("The task or workspace changed. Refresh its result and review the operation again.");
    expect(client.imFeedbackAction).not.toHaveBeenCalled();
  });
  it("does not submit cached confirmation data when its fresh read fails", async () => {
    const client = api();
    client.imFeedback.mockResolvedValueOnce(view()).mockRejectedValue(new Error("read unavailable"));
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry save and release" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm operation" }));
    await screen.findByText("The task or workspace changed. Refresh its result and review the operation again.");
    expect(client.imFeedbackAction).not.toHaveBeenCalled();
  });
  it("checks an unanswered mutation without automatically submitting it again", async () => {
    const client = api();
    client.imFeedbackAction.mockRejectedValue(new Error("lost response"));
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry save and release" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm operation" }));
    await screen.findByText(/Checking the operation result/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh current result" }));
    expect(client.imFeedbackAction).toHaveBeenCalledOnce();
    expect(client.imFeedback).toHaveBeenCalledTimes(4);
  });
  it("does not offer replay of potentially completed task effects", async () => {
    const client = api(view({ state: "failed", sandboxId: null, environmentGeneration: null, actions: [] }));
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    await screen.findByText(/External operations may already have occurred/);
    expect(screen.queryByRole("button", { name: "Retry task" })).toBeNull();
  });
  it("does not label an unverified release as a saved workspace", async () => {
    const client = api(
      view({
        state: "resolved",
        actions: [],
        action: {
          kind: "save_release",
          state: "succeeded",
          resultCode: "released_unverified",
          actorDisplayName: "Alice",
          updatedAt: "2026-11-03T00:00:00Z",
        },
      }),
    );
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    await screen.findByText(/the save\/discard result could not be verified/);
    expect(
      screen.queryByText("Saved and environment released. The next allocation restores the workspace."),
    ).toBeNull();
  });
  it("shows the permanent-loss and external-effects warning in Chinese", async () => {
    overwriteGetLocale(() => "zh");
    const client = api();
    await renderInRouter(<ImFeedbackPage feedbackId={ID} api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "丢弃未保存改动" }));
    expect(screen.getByText(/上次成功保存之后的改动将永久丢失/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "确认操作" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it("explains why a frozen batch has no retry action", async () => {
  await renderInRouter(
    <ImFeedbackPage
      feedbackId={ID}
      api={api(view({ state: "failed", effects: "not_started", retryBlockedReason: "batch_initial", actions: [] }))}
    />,
  );
  expect(
    await screen.findByText(
      "This frozen batch cannot be retried here. Open the original Task and review every input before starting new work.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry task" })).toBeNull();
});

it("keeps workspace recovery available without task-replay guidance for a frozen batch", async () => {
  await renderInRouter(<ImFeedbackPage feedbackId={ID} api={api(view({ retryBlockedReason: "batch_initial" }))} />);
  expect(await screen.findByRole("button", { name: "Retry save and release" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Discard unsaved changes" })).toBeTruthy();
  expect(screen.getByText("Work in this Session is paused. New input for this Session remains queued.")).toBeTruthy();
  expect(
    screen.queryByText(
      "This frozen batch cannot be retried here. Open the original Task and review every input before starting new work.",
    ),
  ).toBeNull();
});
