import { AGENT_RUNTIME_TEST_FAILURE_CODES, type AgentRuntimeTestResponse } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { overwriteGetLocale } from "../../../paraglide/runtime.js";
import { RUNTIME_TEST_FAILURE_CODES, RuntimeTestAction, runtimeTestFailureMessage } from "./runtime-test-action.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

function renderAction(props: { expectedRevision?: number; expectedRuntimeConfigRevision?: number } = {}) {
  return render(
    <RuntimeTestAction
      agentId={agentId}
      expectedRevision={props.expectedRevision ?? 4}
      expectedRuntimeConfigRevision={props.expectedRuntimeConfigRevision ?? 7}
    />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("RuntimeTestAction", () => {
  afterEach(() => {
    overwriteGetLocale(() => "en");
    vi.restoreAllMocks();
  });

  it("explains that the test uses saved settings and provider quota without running until clicked", () => {
    const testRuntime = vi.spyOn(browserApi, "testAgentRuntime");
    renderAction();

    expect(screen.getByText(/saved model settings/)).toBeTruthy();
    expect(screen.getByText(/provider quota/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run test" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(testRuntime).not.toHaveBeenCalled();
  });

  it("explains and enforces a disabled state", () => {
    const testRuntime = vi.spyOn(browserApi, "testAgentRuntime");
    render(
      <RuntimeTestAction
        agentId={agentId}
        disabledReason="Save changes before testing."
        expectedRevision={4}
        expectedRuntimeConfigRevision={7}
      />,
    );

    expect(screen.getByText("Save changes before testing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(testRuntime).not.toHaveBeenCalled();
  });

  it("shows a concise connection success from component state only", async () => {
    const testRuntime = vi.spyOn(browserApi, "testAgentRuntime").mockResolvedValue({ status: "passed" });
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Connection succeeded. The saved model settings worked for this request.",
    );
    expect(testRuntime).toHaveBeenCalledOnce();
    expect(testRuntime).toHaveBeenCalledWith(
      agentId,
      { expectedRevision: 4, expectedRuntimeConfigRevision: 7 },
      expect.any(AbortSignal),
    );
    expect(testRuntime.mock.calls[0]?.[1]).toEqual({
      expectedRevision: 4,
      expectedRuntimeConfigRevision: 7,
    });
    expect(Object.keys(testRuntime.mock.calls[0]?.[1] ?? {})).toEqual([
      "expectedRevision",
      "expectedRuntimeConfigRevision",
    ]);
  });

  it("shows a fixed sanitized failure for every protocol code and request errors", async () => {
    const testRuntime = vi.spyOn(browserApi, "testAgentRuntime");
    for (const code of AGENT_RUNTIME_TEST_FAILURE_CODES) {
      testRuntime.mockResolvedValueOnce({ status: "failed", code });
      const view = renderAction();
      fireEvent.click(screen.getByRole("button", { name: "Run test" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(runtimeTestFailureMessage(code));
      expect(alert.textContent).not.toBe(code);
      expect(alert.textContent).not.toMatch(/sk-|token|sentinel|usage|trace|"status"/i);
      view.unmount();
    }

    testRuntime.mockRejectedValueOnce(new Error("ECONNRESET super-secret-provider-dump"));
    renderAction();
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn’t run the model connection test. Check the connection, then try again.",
    );
    expect(screen.queryByText(/super-secret-provider-dump/)).toBeNull();
  });

  it("disables the action and shows the pending button state until the request settles", async () => {
    const hang = deferred<AgentRuntimeTestResponse>();
    vi.spyOn(browserApi, "testAgentRuntime").mockReturnValue(hang.promise);
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    const pending = await screen.findByRole("button", { name: "Testing…" });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    hang.resolve({ status: "passed" });
    expect((await screen.findByRole("status")).textContent).toMatch(/^Connection succeeded\./);
    expect(screen.getByRole("button", { name: "Run test" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows the stale configuration failure without retrying", async () => {
    const testRuntime = vi
      .spyOn(browserApi, "testAgentRuntime")
      .mockResolvedValue({ status: "failed", code: "stale_configuration" });
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The saved model settings changed. Run the test again to use the current settings.",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(testRuntime).toHaveBeenCalledOnce();
  });

  it("aborts and clears the result when the saved configuration revisions change", async () => {
    const hang = deferred<AgentRuntimeTestResponse>();
    const testRuntime = vi
      .spyOn(browserApi, "testAgentRuntime")
      .mockImplementation((_id, _input, signal) => withAbort(hang.promise, signal));
    const view = renderAction();
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await screen.findByRole("button", { name: "Testing…" });
    const signal = testRuntime.mock.calls[0]?.[2];

    view.rerender(<RuntimeTestAction agentId={agentId} expectedRevision={5} expectedRuntimeConfigRevision={8} />);

    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Testing…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run test" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    hang.resolve({ status: "passed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).toBeNull();
    expect(testRuntime).toHaveBeenCalledOnce();
  });

  it("aborts on unmount and does not keep the result", async () => {
    const hang = deferred<AgentRuntimeTestResponse>();
    const testRuntime = vi
      .spyOn(browserApi, "testAgentRuntime")
      .mockImplementation((_id, _input, signal) => withAbort(hang.promise, signal));
    const view = renderAction();
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await screen.findByRole("button", { name: "Testing…" });
    const signal = testRuntime.mock.calls[0]?.[2];

    view.unmount();
    expect(signal?.aborted).toBe(true);

    hang.resolve({ status: "passed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run test" })).toBeNull();
  });

  it("clears a previous result when a new test starts and never writes storage or retries", async () => {
    const testRuntime = vi
      .spyOn(browserApi, "testAgentRuntime")
      .mockResolvedValueOnce({ status: "passed" })
      .mockResolvedValueOnce({ status: "failed", code: "provider_failed" });
    const storageSet = vi.spyOn(window.localStorage, "setItem");
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/^Connection succeeded\./);

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The model request failed. Check provider access and quota, then try again.",
    );
    expect(testRuntime).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(testRuntime).toHaveBeenCalledTimes(2);
    expect(storageSet).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("localizes the description, pending state, success, and sanitized failures", async () => {
    overwriteGetLocale(() => "zh");
    const hang = deferred<AgentRuntimeTestResponse>();
    vi.spyOn(browserApi, "testAgentRuntime").mockReturnValueOnce(hang.promise);
    const pendingView = renderAction();
    expect(screen.getByText("使用已保存的模型设置发送一个简短请求。此操作可能会消耗 Provider 配额。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "运行测试" }));
    expect(await screen.findByRole("button", { name: "正在测试…" })).toBeTruthy();
    pendingView.unmount();

    vi.spyOn(browserApi, "testAgentRuntime").mockResolvedValueOnce({ status: "passed" });
    const passView = renderAction();
    fireEvent.click(screen.getByRole("button", { name: "运行测试" }));
    expect((await screen.findByRole("status")).textContent).toBe("连接成功。已保存的模型设置在此次请求中正常工作。");
    passView.unmount();

    for (const code of RUNTIME_TEST_FAILURE_CODES) {
      const message = runtimeTestFailureMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toEqual(code);
    }
  });
});

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
