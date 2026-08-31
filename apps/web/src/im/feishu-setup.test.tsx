import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { FeishuSetup } from "./feishu-setup.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const firstAttemptId = "2a63a21e-f6c7-4474-91ea-4dabf0566a24";
const secondAttemptId = "3a63a21e-f6c7-4474-91ea-4dabf0566a24";

function attempt(
  overrides: Partial<FeishuSetupAttempt> & Pick<FeishuSetupAttempt, "id" | "intent" | "state">,
): FeishuSetupAttempt {
  return {
    agentId,
    brand: "feishu",
    qrUrl: null,
    expiresAt: "2026-08-20T00:15:00.000Z",
    errorCode: null,
    completedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function Harness({
  onSuccess = () => undefined,
  presentation = "inline",
}: {
  onSuccess?: () => void;
  presentation?: "dialog" | "inline";
}) {
  return (
    <FeishuSetup agentId={agentId} onSuccess={onSuccess} presentation={presentation}>
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
          {setup.loading ? <span>Loading setup</span> : null}
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
  it("opens the first connection in a dialog and cancels the Server attempt", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({
        id: firstAttemptId,
        intent: "create",
        state: "awaiting_user",
        qrUrl: "https://open.feishu.cn/setup",
      }),
    );
    const cancel = vi
      .spyOn(browserApi, "cancelFeishuSetupAttempt")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "create", state: "canceled" }));
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Feishu" });
    expect(await screen.findByRole("img", { name: "Scan this QR code in Feishu" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Feishu" })).toBeTruthy();
    expect(dialog.textContent).not.toContain("State:");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(firstAttemptId));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect Feishu" })).toBeNull());
  });

  it("shows a non-cancellable finishing state without the QR code", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "reauthorize", state: "validating" }),
    );
    const cancel = vi.spyOn(browserApi, "cancelFeishuSetupAttempt");
    render(<Harness presentation="dialog" />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await screen.findByRole("dialog", { name: "Update Feishu permissions" });
    expect(screen.getByText("Finishing connection…")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Scan this QR code in Feishu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close Update Feishu permissions" }).hasAttribute("disabled")).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

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
    expect(screen.queryByText("Loading setup")).toBeNull();
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

    expect(screen.getByRole("alert").textContent).toBe("Couldn’t connect Feishu. Try scanning a new QR code.");
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

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t connect Feishu. Try scanning a new QR code.");
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
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t connect Feishu. Try scanning a new QR code.");
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(screen.getByText(/State: validating/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t connect Feishu. Try scanning a new QR code.");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("clears a retained poll error when a replacement attempt is accepted", async () => {
    vi.useFakeTimers();
    let resolveReplacement: (value: FeishuSetupAttempt) => void = () => undefined;
    const replacement = new Promise<FeishuSetupAttempt>((resolve) => {
      resolveReplacement = resolve;
    });
    vi.spyOn(browserApi, "createFeishuSetupAttempt")
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "reauthorize", state: "awaiting_user" }))
      .mockReturnValueOnce(replacement);
    vi.spyOn(browserApi, "feishuSetupAttempt").mockRejectedValue(new Error("Old attempt poll failed"));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t connect Feishu. Try scanning a new QR code.");
    await act(async () =>
      resolveReplacement(attempt({ id: secondAttemptId, intent: "replace", state: "awaiting_user" })),
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/State: awaiting_user/)).toBeTruthy();
  });

  it("normalizes non-Error failures into a stable error state", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockRejectedValue("network unavailable");
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t connect Feishu. Try scanning a new QR code.");
  });

  it("explains a Server-reported failure the same way whether or not an attempt exists", async () => {
    const unavailable = "Feishu is unavailable right now. Check the connection and try again.";
    const start = vi
      .spyOn(browserApi, "createFeishuSetupAttempt")
      .mockRejectedValueOnce(
        new ApiError(502, "The request could not be completed", "FEISHU_UPSTREAM_UNAVAILABLE", "transient"),
      )
      .mockResolvedValueOnce(
        attempt({
          id: firstAttemptId,
          intent: "create",
          state: "failed",
          errorCode: "FEISHU_UPSTREAM_UNAVAILABLE",
        }),
      );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe(unavailable);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Feishu is unavailable right now/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /*
   * A bound team's brand is settled, and the Server returns to the domain its App was created on
   * whatever a caller asks for. Offering the switch there would cancel a working code and mint an
   * identical one — an affordance that contradicts what the request can do.
   */
  it("offers the brand switch on a first connect and not on a re-authorization", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockImplementation(async (_agentId, intent) =>
      attempt({
        id: firstAttemptId,
        intent: intent ?? "create",
        brand: "lark",
        state: "awaiting_user",
        qrUrl: "https://accounts.larksuite.com/setup",
      }),
    );
    const { unmount } = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("button", { name: "Use Feishu instead" })).toBeTruthy();
    unmount();

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await screen.findByText(/State: awaiting_user/);
    expect(screen.queryByRole("button", { name: "Use Feishu instead" })).toBeNull();
  });

  /*
   * The code and its switch button stay on screen for the whole release round-trip, so the reader
   * can press twice before the first switch has finished. A second switch that retired the first
   * one's creation mid-air used to leave the panel with no code, no error, and a creation guard
   * that never reset — every later press refused, recoverable only by reloading.
   *
   * Asserted on the settled end state rather than by waiting for a QR: React has not yet removed
   * the code being left, so a wait would happily match the one on its way out.
   */
  it("survives the reader pressing the brand switch twice", async () => {
    const create = vi
      .spyOn(browserApi, "createFeishuSetupAttempt")
      .mockImplementation(async (_agentId, intent, brand) =>
        attempt({
          id: brand === "feishu" ? secondAttemptId : firstAttemptId,
          intent: intent ?? "create",
          brand: brand ?? "lark",
          state: "awaiting_user",
          qrUrl: "https://accounts.example/setup",
        }),
      );
    const cancel = vi
      .spyOn(browserApi, "cancelFeishuSetupAttempt")
      .mockImplementation(async (id) => attempt({ id, intent: "create", state: "canceled", qrUrl: null }));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const firstSwitch = await screen.findByRole("button", { name: "Use Feishu instead" });
    fireEvent.click(firstSwitch);
    fireEvent.click(firstSwitch);
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    // One switch happened, and the panel is still usable rather than silently wedged.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img", { name: "Scan this QR code in Feishu" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /*
   * A release that did not land leaves the code the reader asked to leave still awaiting a scan, so
   * the Server's next create reuses it. Minting after a failed cancel would put the same code back
   * on screen under the other brand's name; saying so is the only honest option.
   */
  it("refuses to switch when the running code cannot be released", async () => {
    const create = vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({
        id: firstAttemptId,
        intent: "create",
        brand: "lark",
        state: "awaiting_user",
        qrUrl: "https://accounts.larksuite.com/setup",
      }),
    );
    vi.spyOn(browserApi, "cancelFeishuSetupAttempt").mockRejectedValue(new ApiError(403, "Request failed"));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use Feishu instead" }));

    expect((await screen.findByRole("alert")).textContent).toBe(m.im_feishu_cancel_failed());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("directs an unexplained terminal failure to the Account owner", async () => {
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", state: "failed" }),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const failedState = await screen.findByText(/State: failed/);
    expect(failedState.closest('[data-ui="feishu-setup-feedback"]')?.textContent).toContain(
      "Couldn’t connect Feishu. Try scanning a new QR code.",
    );
  });
});
