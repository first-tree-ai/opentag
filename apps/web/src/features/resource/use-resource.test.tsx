import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResource } from "./use-resource.js";

function ResourceProbe({ loader }: { loader: () => Promise<string> }) {
  const state = useResource(loader, "resource", { refreshOnFocus: true, revalidateMs: 1_000 });
  if (state.kind === "loading") return <p>Loading</p>;
  if (state.kind === "error") return <p>{state.error.message}</p>;
  return <p>{state.value}</p>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useResource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pauses polling and ignores focus refreshes while the document is hidden", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const loader = vi.fn<() => Promise<string>>().mockImplementation(async () => `value-${loader.mock.calls.length}`);

    render(<ResourceProbe loader={loader} />);
    await act(flushPromises);
    expect(screen.getByText("value-1")).toBeTruthy();

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      window.dispatchEvent(new Event("focus"));
      await flushPromises();
    });
    expect(loader).toHaveBeenCalledTimes(1);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await flushPromises();
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByText("value-2")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await flushPromises();
    });
    expect(loader).toHaveBeenCalledTimes(3);
    expect(screen.getByText("value-3")).toBeTruthy();
  });
});
