/**
 * The edges of one Feishu setup lifecycle: closing the dialog while the attempt is still being
 * created, an attempt that is already finished when it arrives, a cancel the Server refuses, the
 * QR expiry countdown, and one recovery sentence per Server-reported code.
 */

import type { FeishuSetupAttempt } from "@opentag/shared/browser";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { createQueryClient } from "../query/client.js";
import { FeishuSetup } from "./feishu-setup.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const attemptId = "2a63a21e-f6c7-4474-91ea-4dabf0566a24";
const qrUrl = "https://open.feishu.cn/setup";

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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness({
  onSuccess = () => undefined,
  presentation = "inline",
}: {
  onSuccess?: () => void;
  presentation?: "dialog" | "inline";
}) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <FeishuSetup agentId={agentId} onSuccess={onSuccess} presentation={presentation}>
        {(setup) => (
          <>
            <button type="button" onClick={() => void setup.start("create")}>
              Create
            </button>
            <button type="button" onClick={() => void setup.start("reauthorize")}>
              Reauthorize
            </button>
            {setup.loading ? <span>Loading setup</span> : null}
            {setup.feedback}
          </>
        )}
      </FeishuSetup>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FeishuSetup dialog closed while the attempt is still being created", () => {
  it("cancels the attempt the Server answers with once it lands", async () => {
    const creation = deferred<FeishuSetupAttempt>();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockReturnValue(creation.promise);
    const cancel = vi
      .spyOn(browserApi, "cancelFeishuSetupAttempt")
      .mockResolvedValue(attempt({ id: attemptId, intent: "create", state: "canceled" }));
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("dialog", { name: "Connect Lark" });
    expect(screen.getByText("Preparing QR code…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Connect Lark" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull());
    expect(cancel).not.toHaveBeenCalled();

    await act(async () =>
      creation.resolve(attempt({ id: attemptId, intent: "create", state: "awaiting_user", qrUrl })),
    );

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(attemptId));
    expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull();
    expect(screen.queryByText("Loading setup")).toBeNull();
  });

  it("leaves an attempt that is no longer awaiting the reader alone", async () => {
    const creation = deferred<FeishuSetupAttempt>();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockReturnValue(creation.promise);
    const cancel = vi.spyOn(browserApi, "cancelFeishuSetupAttempt");
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("dialog", { name: "Connect Lark" });
    fireEvent.click(screen.getByRole("button", { name: "Close Connect Lark" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull());

    await act(async () => creation.resolve(attempt({ id: attemptId, intent: "create", state: "validating" })));

    expect(cancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull();
  });

  it("reopens the dialog with the attempt when the deferred cancel is refused", async () => {
    const creation = deferred<FeishuSetupAttempt>();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockReturnValue(creation.promise);
    vi.spyOn(browserApi, "cancelFeishuSetupAttempt").mockRejectedValue(new Error("cancel refused"));
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("dialog", { name: "Connect Lark" });
    fireEvent.click(screen.getByRole("button", { name: "Close Connect Lark" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull());

    await act(async () =>
      creation.resolve(attempt({ id: attemptId, intent: "create", state: "awaiting_user", qrUrl })),
    );

    const dialog = await screen.findByRole("dialog", { name: "Connect Lark" });
    expect(dialog.textContent).toContain("Couldn’t cancel Lark setup. Try again.");
    // The Server still owns an open attempt, so its QR is the way forward rather than a blank dialog.
    expect(await screen.findByRole("img", { name: "Scan this QR code in Lark" })).toBeTruthy();
  });
});

describe("FeishuSetup dialog lifecycle", () => {
  it("closes the dialog and reports success when the attempt arrives already succeeded", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "reauthorize", state: "succeeded" }),
    );
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Loading setup")).toBeNull();
  });

  it("closes the dialog once polling observes success", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "create", state: "awaiting_user", qrUrl }),
    );
    const poll = vi
      .spyOn(browserApi, "feishuSetupAttempt")
      .mockResolvedValue(attempt({ id: attemptId, intent: "create", state: "succeeded" }));
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("dialog", { name: "Connect Lark" });

    // The poll runs on its real 1.5s cadence here so the dialog's close transition can settle too.
    await waitFor(() => expect(poll).toHaveBeenCalledWith(attemptId), { timeout: 4_000 });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull());
  }, 10_000);

  it("keeps a refused cancel visible and ignores a second cancel while the first is pending", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "create", state: "awaiting_user", qrUrl }),
    );
    const cancellation = deferred<FeishuSetupAttempt>();
    const cancel = vi.spyOn(browserApi, "cancelFeishuSetupAttempt").mockReturnValue(cancellation.promise);
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);
    fireEvent.click(cancelButton);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

    await act(async () => cancellation.reject(new Error("cancel refused")));

    const dialog = screen.getByRole("dialog", { name: "Connect Lark" });
    expect(dialog.textContent).toContain("Couldn’t cancel Lark setup. Try again.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("offers a new code for an expired attempt and clears the dialog on Close", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "create", state: "expired" }),
    );
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Lark" });
    expect(dialog.textContent).toContain("This QR code expired. Generate a new one and try again.");
    expect(screen.getByRole("button", { name: "Generate new code" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Lark" })).toBeNull());
    // The retained terminal attempt is dropped with the dialog; a fresh open starts clean.
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("dialog", { name: "Connect Lark" })).textContent).toContain(
      "This QR code expired. Generate a new one and try again.",
    );
  });

  it("offers Try again when the start itself fails before any attempt exists", async () => {
    const create = vi
      .spyOn(browserApi, "createFeishuSetupAttempt")
      .mockRejectedValueOnce(new ApiError(409, "conflict", "FEISHU_SETUP_DENIED", "deterministic"))
      .mockResolvedValueOnce(attempt({ id: attemptId, intent: "create", state: "awaiting_user" }));
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Lark authorization was declined. Try again and approve the requested permissions.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    // Without a QR the reader can still cancel, but there is nothing to open.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in Lark" })).toBeNull();
  });

  it("counts down to the QR expiry and says when it has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:12:30.000Z"));
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "create", state: "awaiting_user", qrUrl }),
    );
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "create", state: "awaiting_user", qrUrl }),
    );
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    expect(screen.getByText("Expires in 3 min")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText("Expires in 2 min")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByText("QR code expired")).toBeTruthy();
  });
});

describe("FeishuSetup recovery copy", () => {
  it("does not apply a start that lands after the surface has gone", async () => {
    const creation = deferred<FeishuSetupAttempt>();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockReturnValue(creation.promise);
    const onSuccess = vi.fn();
    const view = render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    view.unmount();
    await act(async () => creation.resolve(attempt({ id: attemptId, intent: "create", state: "succeeded" })));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not surface a failure that lands after the surface has gone", async () => {
    const creation = deferred<FeishuSetupAttempt>();
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockReturnValue(creation.promise);
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    view.unmount();
    await act(async () => creation.reject(new Error("too late")));

    expect(document.body.textContent).toBe("");
  });

  it.each([
    ["expired", "This QR code expired. Generate a new one and try again."],
    ["canceled", "Lark setup was canceled."],
  ] as const)("explains a terminal %s attempt that carries no code", async (state, message) => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: attemptId, intent: "reauthorize", state }),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));

    const feedback = (await screen.findByText(new RegExp(`State: ${state}`))).closest(
      '[data-ui="feishu-setup-feedback"]',
    );
    expect(feedback?.textContent).toContain(message);
    expect(feedback?.textContent).toContain("Confirm the updated permissions for the current Lark Bot.");
    expect(screen.getByRole("button", { name: "Retry Lark setup" })).toBeTruthy();
  });

  it.each([
    [
      "FEISHU_SCOPE_REAUTH_REQUIRED",
      "Lark permissions are incomplete. Try again and approve all requested permissions.",
    ],
    [
      "IM_BINDING_SCOPE_REAUTH_REQUIRED",
      "Lark permissions are incomplete. Try again and approve all requested permissions.",
    ],
    ["FEISHU_SETUP_DENIED", "Lark authorization was declined. Try again and approve the requested permissions."],
    ["FEISHU_SETUP_EXPIRED", "This QR code expired. Generate a new one and try again."],
    ["FEISHU_SETUP_CANCELED", "Lark setup was canceled."],
    ["FEISHU_SETUP_OWNER_RESTARTED", "Lark setup was interrupted. Generate a new QR code and try again."],
    [
      "FEISHU_BINDING_IDENTITY_MISMATCH",
      "This Lark bot does not match the current connection. Try again with the current bot, or choose Change bot.",
    ],
    ["SOMETHING_ELSE", "Couldn’t connect Lark. Try scanning a new QR code."],
  ])("maps the Server code %s onto its recovery sentence", async (code, message) => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockRejectedValue(
      new ApiError(409, "The request could not be completed", code, "deterministic"),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });
});
