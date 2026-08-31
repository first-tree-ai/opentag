import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCENARIOS, useMockBackend } from "./mock-backend.js";

describe("useMockBackend Computer connection isolation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels issuance from the previous Review Lab inventory", async () => {
    vi.useFakeTimers();
    const scenario = SCENARIOS[0];
    if (!scenario) throw new Error("The Review Lab must offer its default scenario");
    const view = renderHook(
      ({ inventory }: { inventory: "none" | "one-offline" }) => useMockBackend(scenario, "manual", inventory),
      { initialProps: { inventory: "none" as "none" | "one-offline" } },
    );

    act(() => {
      void view.result.current.computerConnectAdapter?.issue({ mode: "create" });
    });
    view.rerender({ inventory: "one-offline" });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(view.result.current.pending?.label).toBe("Reconnect MacBook Pro");
    expect(view.result.current.knownComputers).toEqual([
      expect.objectContaining({ id: "mac", availability: "offline" }),
    ]);
  });

  it("clears later-stage state when Review Lab switches Accounts", async () => {
    vi.useFakeTimers();
    const scenario = SCENARIOS[0];
    if (!scenario) throw new Error("The Review Lab must offer its default scenario");
    const view = renderHook(
      ({ inventory }: { inventory: "one-online" | "one-offline" }) => useMockBackend(scenario, "manual", inventory),
      { initialProps: { inventory: "one-online" as "one-online" | "one-offline" } },
    );

    act(() =>
      view.result.current.createAgent({
        cloudRuntime: undefined,
        destination: "local",
        name: "ada",
        runtime: "codex",
        tokenSource: undefined,
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(900));
    act(() => {
      view.result.current.startMessaging("feishu");
      view.result.current.startPlanSignIn();
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(view.result.current.agent).toBeDefined();
    expect(view.result.current.messaging.kind).not.toBe("idle");

    view.rerender({ inventory: "one-offline" });

    expect(view.result.current.agent).toBeUndefined();
    expect(view.result.current.creation).toBe("idle");
    expect(view.result.current.messaging).toEqual({ kind: "idle" });
    expect(view.result.current.planSignIn).toBe("idle");
  });
});
