import { type Mock, type MockInstance, vi } from "vitest";

/** An isolated browser channel and window; provider pages and credentials are never contacted. */
type FakePopup = {
  closed: boolean;
  opener: Window | null;
  document: Document;
  sessionStorage: { setItem: (key: string, value: string) => void };
  location: { replace: Mock<(url: string) => void> };
  close: Mock<() => void>;
};
type FakeOAuthBrowser = {
  popup: FakePopup;
  open: MockInstance<Window["open"]>;
  send: (outcome: unknown) => void;
  data: Map<string, string>;
  restore: () => void;
};
export function fakeMcpOAuthBrowser(): FakeOAuthBrowser {
  const original = globalThis.BroadcastChannel;
  const channels = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) {
      const group = channels.get(name) ?? new Set();
      group.add(this);
      channels.set(name, group);
    }
    postMessage(data: unknown) {
      for (const receiver of channels.get(this.name) ?? []) {
        if (receiver !== this) receiver.onmessage?.({ data } as MessageEvent<unknown>);
      }
    }
    close() {
      channels.get(this.name)?.delete(this);
    }
  }
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: FakeChannel });
  const data = new Map<string, string>();
  const popup: FakePopup = {
    closed: false,
    opener: window,
    document: document.implementation.createHTMLDocument(),
    sessionStorage: { setItem: (key: string, value: string) => data.set(key, value) },
    location: { replace: vi.fn() },
    close: vi.fn(() => {
      popup.closed = true;
    }),
  };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const send = (outcome: unknown) => {
    const ticket = JSON.parse(data.get("opentag:mcp:oauth-window") ?? "{}");
    if (!ticket.channel) throw new Error("Authorization window is not ready");
    const sender = new FakeChannel(ticket.channel);
    sender.postMessage(outcome);
    sender.close();
  };
  const restore = () => {
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: original });
    open.mockRestore();
  };
  return { popup, open, send, data, restore };
}
