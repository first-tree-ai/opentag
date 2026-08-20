import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { FeishuSetup } from "./feishu-setup.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const firstAttemptId = "2a63a21e-f6c7-4474-91ea-4dabf0566a24";
const secondAttemptId = "3a63a21e-f6c7-4474-91ea-4dabf0566a24";

function attempt(
  overrides: Partial<FeishuSetupAttempt> & Pick<FeishuSetupAttempt, "id" | "intent" | "state">,
): FeishuSetupAttempt {
  return {
    agentId,
    qrUrl: null,
    expiresAt: "2026-08-20T00:15:00.000Z",
    errorCode: null,
    completedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function Harness({ onSuccess = () => undefined }: { onSuccess?: () => void }) {
  return (
    <FeishuSetup agentId={agentId} onSuccess={onSuccess}>
      {(setup) => (
        <>
          <button type="button" onClick={() => void setup.start("create")}>
            Create
          </button>
          <button type="button" onClick={() => void setup.start("reauthorize")}>
            Reauthorize
          </button>
          <button type="button" onClick={() => void setup.start("replace")}>
            Replace
          </button>
          {setup.feedback}
        </>
      )}
    </FeishuSetup>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FeishuSetup", () => {
  it("renders the setup link and generated QR without creating duplicate attempts", async () => {
    const create = vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({
        id: firstAttemptId,
        intent: "create",
        state: "awaiting_user",
        qrUrl: "https://open.feishu.cn/setup",
      }),
    );
    render(<Harness />);

    const button = screen.getByRole("button", { name: "Create" });
    fireEvent.click(button);
    fireEvent.click(button);

    const link = (await screen.findByRole("link", { name: "Open Feishu authorization" })) as HTMLAnchorElement;
    expect(link.href).toBe("https://open.feishu.cn/setup");
    expect(await screen.findByRole("img", { name: "Scan this QR code in Feishu" })).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("polls a pending attempt to success once and invokes the narrow success callback", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "reauthorize", state: "awaiting_user" }),
    );
    const poll = vi
      .spyOn(browserApi, "feishuSetupAttempt")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "reauthorize", state: "succeeded" }));
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(screen.getByText(/State: succeeded/)).toBeTruthy();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(firstAttemptId);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("normalizes polling errors and keeps the active lifecycle polling", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", state: "awaiting_user" }),
    );
    const poll = vi
      .spyOn(browserApi, "feishuSetupAttempt")
      .mockRejectedValueOnce("network unavailable")
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "create", state: "succeeded" }));
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(screen.getByRole("alert").textContent).toBe("Unable to refresh setup");
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(poll).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/State: succeeded/)).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("replaces the active polling lifecycle and cleans it up on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockImplementation(
      async (_agentId: string, intent: FeishuSetupIntent = "create") =>
        attempt({
          id: intent === "replace" ? secondAttemptId : firstAttemptId,
          intent,
          state: "awaiting_user",
        }),
    );
    const poll = vi
      .spyOn(browserApi, "feishuSetupAttempt")
      .mockImplementation(async (attemptId) => attempt({ id: attemptId, intent: "replace", state: "validating" }));
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(secondAttemptId);

    view.unmount();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("retries a terminal attempt with its original intent", async () => {
    const create = vi
      .spyOn(browserApi, "createFeishuSetupAttempt")
      .mockResolvedValueOnce(
        attempt({
          id: firstAttemptId,
          intent: "replace",
          state: "failed",
          errorCode: "FEISHU_APP_ALREADY_BOUND",
        }),
      )
      .mockResolvedValueOnce(attempt({ id: secondAttemptId, intent: "replace", state: "awaiting_user" }));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(await screen.findByText(/already connected to another Agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Feishu setup" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls.map(([, intent]) => intent)).toEqual(["replace", "replace"]);
  });

  it("retains the Server-owned terminal attempt when its retry fails to start", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt")
      .mockResolvedValueOnce(
        attempt({
          id: firstAttemptId,
          intent: "replace",
          state: "failed",
          errorCode: "FEISHU_APP_ALREADY_BOUND",
        }),
      )
      .mockRejectedValueOnce(new Error("Retry unavailable"));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(await screen.findByText(/already connected to another Agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Feishu setup" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Retry unavailable");
    expect(screen.getByText(/State: failed/)).toBeTruthy();
    expect(screen.getByText(/already connected to another Agent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Feishu setup" })).toBeTruthy();
  });

  it("does not regress a terminal poll with a late reused start snapshot", async () => {
    vi.useFakeTimers();
    let resolveReplacement: (value: FeishuSetupAttempt) => void = () => undefined;
    const replacement = new Promise<FeishuSetupAttempt>((resolve) => {
      resolveReplacement = resolve;
    });
    vi.spyOn(browserApi, "createFeishuSetupAttempt")
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "reauthorize", state: "awaiting_user" }))
      .mockReturnValueOnce(replacement);
    const poll = vi
      .spyOn(browserApi, "feishuSetupAttempt")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "reauthorize", state: "succeeded" }));
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await act(async () =>
      resolveReplacement(attempt({ id: firstAttemptId, intent: "reauthorize", state: "awaiting_user" })),
    );

    expect(screen.getByText(/State: succeeded/)).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed intent-switch error while the retained attempt keeps polling", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createFeishuSetupAttempt")
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "reauthorize", state: "awaiting_user" }))
      .mockRejectedValueOnce(new Error("Replacement unavailable"));
    const poll = vi
      .spyOn(browserApi, "feishuSetupAttempt")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "reauthorize", state: "validating" }));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toBe("Replacement unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(screen.getByText(/State: validating/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Replacement unavailable");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-Error failures into a stable error state", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockRejectedValue("network unavailable");
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Unable to start setup");
  });
});
