import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "../services/im-bindings/feishu/adapter.js";

const sdk = vi.hoisted(() => ({
  outbound: {
    botIdentity: { openId: "ou_test", name: "Test Bot" },
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn<() => Promise<void>>(),
  },
  start: vi.fn<() => Promise<void>>(),
  close: vi.fn(),
  options: {} as {
    onReady: () => void;
    onError: (error: unknown) => void;
    onReconnecting: () => void;
    onReconnected: () => void;
  },
}));

vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@larksuiteoapi/node-sdk")>()),
  createLarkChannel: () => sdk.outbound,
  WSClient: class {
    constructor(options: typeof sdk.options) {
      sdk.options = options;
    }
    start() {
      return sdk.start();
    }
    close(options: unknown) {
      sdk.close(options);
    }
  },
}));

function adapter() {
  return new FeishuAdapter({ appId: "cli_test", appSecret: "test-secret", teamId: null });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function outcome(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}

describe("reliable Feishu channel connection failures", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);

  beforeEach(() => {
    vi.resetAllMocks();
    sdk.outbound.connect.mockResolvedValue(undefined);
    sdk.outbound.disconnect.mockResolvedValue(undefined);
    sdk.start.mockResolvedValue(undefined);
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(async () => {
    try {
      await setImmediate();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("handles an early gateway refusal while outbound identity is still pending", async () => {
    const outbound = deferred();
    sdk.outbound.connect.mockReturnValueOnce(outbound.promise);
    const value = adapter();
    const onError = vi.fn();
    value.channel.on({ error: onError });
    const pending = outcome(value.validateBinding());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    const cause = Object.assign(new Error("gateway refused"), { code: 514 });
    sdk.options.onError(cause);
    await setImmediate();
    try {
      expect(settled).toBe(true);
      expect(sdk.close).toHaveBeenCalledWith({ force: true });
    } finally {
      outbound.resolve();
    }
    expect((await pending).error).toMatchObject({ message: "FEISHU_CONNECTION_ERROR", cause });
    await setImmediate();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause);
    expect(sdk.close).toHaveBeenCalledWith({ force: true });
    expect(sdk.outbound.disconnect).toHaveBeenCalled();
    expect(value.channel.botIdentity).toBeUndefined();
  });

  it("preserves an outbound failure and consumes a later gateway refusal", async () => {
    const cause = new Error("outbound identity failed");
    sdk.outbound.connect.mockRejectedValueOnce(cause);
    const value = adapter();
    expect((await outcome(value.validateBinding())).error).toBe(cause);
    sdk.options.onError(new Error("late gateway refusal"));
    await setImmediate();
    expect(sdk.close).toHaveBeenCalledWith({ force: true });
    expect(sdk.outbound.disconnect).toHaveBeenCalled();
    expect(value.channel.botIdentity).toBeUndefined();
  });

  it("returns a rejected SDK start to the caller with its original cause", async () => {
    const cause = new Error("SDK start failed");
    sdk.start.mockRejectedValueOnce(cause);
    const value = adapter();
    const onError = vi.fn();
    value.channel.on({ error: onError });
    const pending = outcome(value.validateBinding());
    await setImmediate();
    sdk.options.onReady();
    expect((await pending).error).toMatchObject({ message: "FEISHU_CONNECTION_ERROR", cause });
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause);
    expect(sdk.close).toHaveBeenCalledWith({ force: true });
    expect(value.channel.botIdentity).toBeUndefined();
  });

  it("preserves the connection error even when outbound cleanup fails", async () => {
    const cause = new Error("outbound identity failed");
    sdk.outbound.connect.mockRejectedValueOnce(cause);
    sdk.outbound.disconnect.mockRejectedValue(new Error("cleanup failed"));
    const value = adapter();
    expect((await outcome(value.validateBinding())).error).toBe(cause);
    expect(sdk.close).toHaveBeenCalledWith({ force: true });
  });

  it("does not start either connection for an already-aborted caller", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const value = adapter();
    expect((await outcome(value.validateBinding(controller.signal))).error).toBe(reason);
    expect(sdk.start).not.toHaveBeenCalled();
    expect(sdk.outbound.connect).not.toHaveBeenCalled();
    await value.channel.disconnect();
  });

  it("quarantines late outbound success and SDK failures after abort", async () => {
    const outbound = deferred();
    const start = deferred();
    sdk.outbound.connect.mockReturnValueOnce(outbound.promise);
    sdk.start.mockReturnValueOnce(start.promise);
    const controller = new AbortController();
    const value = adapter();
    const pending = outcome(value.validateBinding(controller.signal));
    const reason = new Error("cancelled");
    controller.abort(reason);
    expect((await pending).error).toBe(reason);
    sdk.options.onError(new Error("gateway failed after abort"));
    start.reject(new Error("start failed after abort"));
    await setImmediate();
    outbound.resolve();
    sdk.options.onReady();
    await setImmediate();
    expect(value.channel.botIdentity).toBeUndefined();
    expect(sdk.outbound.disconnect).toHaveBeenCalled();
    await expect(value.validateBinding()).rejects.toThrow("FEISHU_CHANNEL_CLOSED");
  });

  it("settles a pending validation on disconnect and consumes late SDK errors", async () => {
    const value = adapter();
    const pending = outcome(value.validateBinding());
    await setImmediate();
    await value.channel.disconnect();
    await setImmediate();
    sdk.options.onReady();
    sdk.options.onError(new Error("late close error"));
    expect((await pending).error).toMatchObject({ message: "FEISHU_CHANNEL_CLOSED" });
    expect(value.channel.botIdentity).toBeUndefined();
  });

  it("keeps successful channels reconnectable and retries failures through a fresh channel", async () => {
    const failed = adapter();
    const failure = outcome(failed.validateBinding());
    sdk.options.onError(new Error("first connection failed"));
    expect((await failure).error).toMatchObject({ message: "FEISHU_CONNECTION_ERROR" });
    await expect(failed.validateBinding()).rejects.toThrow("FEISHU_CHANNEL_CLOSED");

    const value = adapter();
    const handlers = { error: vi.fn(), reconnecting: vi.fn(), reconnected: vi.fn() };
    value.channel.on(handlers);
    const pending = value.validateBinding();
    sdk.options.onReady();
    await expect(pending).resolves.toMatchObject({ externalBotId: "ou_test" });
    sdk.close.mockClear();
    const cause = new Error("temporary connection loss");
    sdk.options.onReconnecting();
    sdk.options.onError(cause);
    sdk.options.onReconnected();
    await setImmediate();
    expect(handlers.error).toHaveBeenCalledExactlyOnceWith(cause);
    expect(handlers.reconnecting).toHaveBeenCalledOnce();
    expect(handlers.reconnected).toHaveBeenCalledOnce();
    expect(sdk.close).not.toHaveBeenCalled();
    expect(value.channel.botIdentity).toEqual(sdk.outbound.botIdentity);
    await value.channel.disconnect();
  });
});
