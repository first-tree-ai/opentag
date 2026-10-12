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
    const prepared = prepareMcpOAuthWindow({ name: "Notion" });
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(browser.popup.document.title).toBe("Connect Notion · OpenTag");
    expect(browser.popup.document.body.textContent).toBe("Connect NotionOpening authorization page…");
    expect(browser.popup.document.querySelector('[role="status"]')?.textContent).toContain(
      "Opening authorization page…",
    );
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
it("carries the theme and font styles into an isolated preparation document", () => {
  const browser = fakeMcpOAuthBrowser();
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/assets/theme.css";
  const inline = document.createElement("style");
  inline.textContent = ":root { --brand: purple; }";
  document.head.append(stylesheet, inline);
  try {
    prepareMcpOAuthWindow({ name: "Notion" });
    expect(browser.popup.document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')?.href).toBe(
      stylesheet.href,
    );
    expect(browser.popup.document.head.textContent).toContain(inline.textContent);
    expect(browser.popup.document.body.textContent).not.toContain("Discover");
  } finally {
    stylesheet.remove();
    inline.remove();
    browser.restore();
  }
});
it("fits the requested window within the screen and centers it on the current browser", () => {
  const browser = fakeMcpOAuthBrowser();
  vi.spyOn(window.screen, "availWidth", "get").mockReturnValue(640);
  vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(600);
  try {
    prepareMcpOAuthWindow();
    const features = Object.fromEntries(
      String(browser.open.mock.calls[0]?.[2])
        .split(",")
        .filter((part) => part.includes("="))
        .map((part) => part.split("=")),
    );
    expect(Number(features.width)).toBeLessThanOrEqual(560);
    expect(Number(features.height)).toBeLessThanOrEqual(720);
    expect(Number(features.height) + Math.max(0, window.outerHeight - window.innerHeight) + 32).toBeLessThanOrEqual(
      600,
    );
    expect(Number(features.left)).toBe(Math.round(window.screenX + (window.outerWidth - Number(features.width)) / 2));
  } finally {
    browser.restore();
  }
});
it("keeps the shared service-icon fallback when the provider artwork fails", () => {
  const browser = fakeMcpOAuthBrowser();
  try {
    prepareMcpOAuthWindow({ name: "Notion", iconUrl: "/missing-notion.png" });
    const image = browser.popup.document.querySelector("img");
    expect(image).not.toBeNull();
    image?.dispatchEvent(new Event("error"));
    expect(browser.popup.document.querySelector("img")).toBeNull();
    expect(browser.popup.document.querySelector("main > span svg")).not.toBeNull();
    expect(browser.popup.document.querySelector("h1")?.textContent).toBe("Connect Notion");
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
