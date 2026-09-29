import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMcpImport } from "./mcp-import-panel.js";

const FRAGMENT = JSON.stringify({
  mcpServers: {
    nevent: { type: "http", url: "https://mcp.nevent.ai", headers: { Authorization: "Bearer sk-imported" } },
  },
});

describe("import paste state", () => {
  it("clears a parsed result as soon as the text changes", async () => {
    const { result } = renderHook(() => useMcpImport([]));
    act(() => result.current.setPaste(FRAGMENT));
    await act(async () => {
      await result.current.analyze();
    });
    expect(result.current.outcome?.kind).toBe("parsed");
    act(() => result.current.setPaste(FRAGMENT.replace("sk-imported", "")));
    // The listed Server and its credential described the previous text; neither may stay actionable.
    expect(result.current.outcome).toBeUndefined();
  });

  it("discards a read that lands after the text changed", async () => {
    const { result } = renderHook(() => useMcpImport([]));
    act(() => result.current.setPaste(FRAGMENT));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.analyze();
    });
    act(() => result.current.setPaste("mcpServers: {}"));
    await act(async () => {
      await pending;
    });
    expect(result.current.outcome).toBeUndefined();
  });

  it("keeps the result while the text is unchanged and re-reads on demand", async () => {
    const { result } = renderHook(() => useMcpImport([]));
    act(() => result.current.setPaste(FRAGMENT));
    await act(async () => {
      await result.current.analyze();
    });
    const first = result.current.outcome;
    await act(async () => {
      await result.current.analyze();
    });
    expect(result.current.outcome?.kind).toBe("parsed");
    expect(result.current.outcome).not.toBe(first);
  });

  it("reads nothing from an empty paste", async () => {
    const { result } = renderHook(() => useMcpImport([]));
    act(() => result.current.setPaste("   "));
    await act(async () => {
      await result.current.analyze();
    });
    expect(result.current.outcome).toBeUndefined();
  });
});
