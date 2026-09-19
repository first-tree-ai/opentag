import type { FeishuSetupAttempt } from "@opentag/shared/browser";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { createQueryClient } from "../query/client.js";
import { FeishuSetup } from "./feishu-setup.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const attemptId = "2a63a21e-f6c7-4474-91ea-4dabf0566a24";
function pending(overrides: Partial<FeishuSetupAttempt> = {}): FeishuSetupAttempt {
  return {
    id: attemptId,
    agentId,
    intent: "reauthorize",
    state: "pending_activation",
    qrUrl: null,
    expiresAt: "2026-10-19T00:00:00.000Z",
    createdAt: "2026-09-19T00:00:00.000Z",
    completedAt: null,
    errorCode: null,
    activation: {
      appId: "cli_saved",
      reason: "permissions_pending",
      missingScopes: ["im:message"],
      nextCheckAt: "2026-09-19T00:01:00.000Z",
      lastCheckedAt: null,
    },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function harness(onSuccess = vi.fn()) {
  const client = createQueryClient();
  const element = (id = agentId) => (
    <QueryClientProvider client={client}>
      <FeishuSetup agentId={id} presentation="dialog" restoreSavedAttempt onSuccess={onSuccess}>
        {(setup) => (
          <>
            <button type="button" onClick={() => void setup.start("replace")}>
              Replace
            </button>
            {setup.feedback}
          </>
        )}
      </FeishuSetup>
    </QueryClientProvider>
  );
  return { element, onSuccess };
}
afterEach(() => {
  vi.restoreAllMocks();
});
function mockSaved() {
  vi.spyOn(browserApi, "currentFeishuSetupAttempt").mockResolvedValue(pending());
  const get = vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(pending());
  const create = vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(pending());
  return { get, create };
}

describe("saved Feishu authorization restoration", () => {
  it("restores on remount, exposes check/cancel inline, and never creates another authorization", async () => {
    const { create } = mockSaved();
    const check = vi.spyOn(browserApi, "checkFeishuSetupAttempt").mockResolvedValue(pending());
    const cancel = vi
      .spyOn(browserApi, "cancelFeishuSetupAttempt")
      .mockResolvedValue(pending({ state: "canceled", activation: undefined }));
    const value = harness();
    const first = render(value.element());
    await screen.findByRole("button", { name: "Check latest status" });
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();
    render(value.element());
    fireEvent.click(await screen.findByRole("button", { name: "Check latest status" }));
    await waitFor(() => expect(check).toHaveBeenCalledWith(attemptId));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel connection request" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(attemptId));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check latest status" })).toBeNull());
    expect(create).not.toHaveBeenCalled();
  });
  it("polls a restored authorization to success once", async () => {
    const { get, create } = mockSaved();
    const value = harness();
    render(value.element());
    await screen.findByRole("button", { name: "Check latest status" });
    get.mockResolvedValue(pending({ state: "succeeded", activation: undefined }));
    await waitFor(() => expect(value.onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(create).not.toHaveBeenCalled();
  });
  it("does not let a late observation overwrite a user-started replacement", async () => {
    const restore = deferred<FeishuSetupAttempt>();
    vi.spyOn(browserApi, "currentFeishuSetupAttempt").mockReturnValue(restore.promise);
    const get = vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(pending());
    const replacement = pending({
      id: "3a63a21e-f6c7-4474-91ea-4dabf0566a24",
      intent: "replace",
      state: "awaiting_user",
      activation: undefined,
      qrUrl: "https://feishu.example/new",
    });
    const create = vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(replacement);
    const value = harness();
    render(value.element());
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await act(async () => restore.resolve(pending()));
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel connection request" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open in Lark" }).getAttribute("href")).toBe("https://feishu.example/new");
  });
  it.each(["unmount", "agent switch"])("ignores a late attempt after %s", async (mode) => {
    const saved = deferred<FeishuSetupAttempt>();
    const get = vi.spyOn(browserApi, "currentFeishuSetupAttempt").mockReturnValue(saved.promise);
    const value = harness();
    const mounted = render(value.element());
    await waitFor(() => expect(get).toHaveBeenCalled());
    if (mode === "unmount") mounted.unmount();
    else mounted.rerender(value.element("4a63a21e-f6c7-4474-91ea-4dabf0566a24"));
    await act(async () => saved.resolve(pending({ state: "succeeded", activation: undefined })));
    expect(value.onSuccess).not.toHaveBeenCalled();
  });
  it("reports a failed restore without claiming authorization failed or creating a QR", async () => {
    vi.spyOn(browserApi, "currentFeishuSetupAttempt").mockRejectedValue(new Error("offline"));
    const create = vi.spyOn(browserApi, "createFeishuSetupAttempt");
    render(harness().element());
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Couldn’t load the connection status. Refresh this page to try again.",
    );
    expect(create).not.toHaveBeenCalled();
  });
});
