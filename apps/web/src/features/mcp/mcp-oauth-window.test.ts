import { afterEach, expect, it, vi } from "vitest";
import { fakeMcpOAuthBrowser } from "./mcp-oauth-test-fixtures.js";
import {
  prepareMcpOAuthWindow,
  publishMcpOAuthWindowReturn,
  readMcpOAuthWindowReturn,
  waitMcpOAuthWindow,
} from "./mcp-oauth-window.js";
import { AGENT_ID, SERVER_ID } from "./mcp-test-fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});
it("reserves before discovery and accepts only the matching server's callback", async () => {
  const browser = fakeMcpOAuthBrowser();
  try {
    const prepared = prepareMcpOAuthWindow();
    expect(browser.open).toHaveBeenCalledWith("", "_blank");
    expect(browser.popup.document.body.textContent).toBe("");
    const abort = new AbortController();
    if (!prepared.popup) throw new Error("Missing test window");
    const pending = waitMcpOAuthWindow(
      prepared.popup,
      "https://provider.test/authorize",
      { agentId: AGENT_ID, serverId: SERVER_ID },
      abort.signal,
    );
    expect(browser.popup.opener).toBeNull();
    browser.send({ mcpServerId: "other-server", outcome: { kind: "success" } });
    expect(browser.popup.close).not.toHaveBeenCalled();
    const result = { mcpServerId: SERVER_ID, outcome: { kind: "success" } };
    browser.send(result);
    expect(await pending).toEqual(result);
    expect(browser.popup.close).toHaveBeenCalledTimes(1);
  } finally {
    browser.restore();
  }
});
it("uses same-tab authorization on mobile without opening a window", () => {
  const browser = fakeMcpOAuthBrowser();
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  try {
    expect(prepareMcpOAuthWindow()).toEqual({ popup: null, mobile: true });
    expect(browser.open).not.toHaveBeenCalled();
  } finally {
    browser.restore();
  }
});
it.each(["closed", "timeout"] as const)("finishes a %s window without treating it as authorization", async (kind) => {
  vi.useFakeTimers();
  const browser = fakeMcpOAuthBrowser();
  try {
    const popup = prepareMcpOAuthWindow().popup;
    if (!popup) throw new Error("Missing test window");
    const abort = new AbortController();
    const pending = waitMcpOAuthWindow(
      popup,
      "https://provider.test/authorize",
      { agentId: AGENT_ID, serverId: SERVER_ID },
      abort.signal,
    );

    if (kind === "closed") browser.popup.closed = true;
    await vi.advanceTimersByTimeAsync(kind === "closed" ? 500 : 10 * 60 * 1000);
    if (kind === "closed") abort.abort();
    expect(await pending).toBe(kind);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    browser.restore();
  }
});
it("cancels and closes the reserved window on abort", async () => {
  const browser = fakeMcpOAuthBrowser();
  try {
    const popup = prepareMcpOAuthWindow().popup;
    if (!popup) throw new Error("Missing test window");
    const abort = new AbortController();
    const pending = waitMcpOAuthWindow(
      popup,
      "https://provider.test/authorize",
      { agentId: AGENT_ID, serverId: SERVER_ID },
      abort.signal,
    );
    abort.abort();
    expect(await pending).toBe("closed");
  } finally {
    browser.restore();
  }
});
it("publishes the existing callback outcome without needing window.opener", () => {
  const browser = fakeMcpOAuthBrowser();
  try {
    const popup = prepareMcpOAuthWindow().popup;
    if (!popup) throw new Error("Missing test window");
    const abort = new AbortController();
    void waitMcpOAuthWindow(
      popup,
      "https://provider.test/authorize",
      { agentId: AGENT_ID, serverId: SERVER_ID },
      abort.signal,
    );
    const ticket = browser.data.get("opentag:mcp:oauth-window");
    if (!ticket) throw new Error("Missing popup ticket");
    window.sessionStorage.setItem("opentag:mcp:oauth-window", ticket);
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/mcp?mcp_oauth=success&server=${SERVER_ID}`);
    expect(readMcpOAuthWindowReturn("another-agent")).toBeUndefined();
    const returned = readMcpOAuthWindowReturn(AGENT_ID);
    if (!returned) throw new Error("Missing callback outcome");
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    publishMcpOAuthWindowReturn(returned);
    expect(close).toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("opentag:mcp:oauth-window")).toBeNull();
  } finally {
    browser.restore();
  }
});

it("does not mistake a severed provider window for cancellation", async () => {
  vi.useFakeTimers();
  const browser = fakeMcpOAuthBrowser();
  try {
    const popup = prepareMcpOAuthWindow().popup;
    if (!popup) throw new Error("Missing test window");
    const detached = vi.fn();
    const pending = waitMcpOAuthWindow(
      popup,
      "https://provider.test/authorize",
      { agentId: AGENT_ID, serverId: SERVER_ID },
      new AbortController().signal,
      detached,
    );
    browser.popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(detached).toHaveBeenCalledTimes(1);
    expect(browser.popup.close).not.toHaveBeenCalled();
    const result = { mcpServerId: SERVER_ID, outcome: { kind: "success" } };
    browser.send(result);
    expect(await pending).toEqual(result);
  } finally {
    browser.restore();
  }
});
