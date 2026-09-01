import { describe, expect, it, vi } from "vitest";
import { createChannelTargetPoller } from "../services/channel-target/index.js";

function pointerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stagingPointer(version: string, channel = "staging") {
  return { schemaVersion: 1, channel, version, manifestUrl: `https://download.test/staging/${version}/manifest.json` };
}

describe("channel target poller", () => {
  it("never advertises a target on the dev channel", async () => {
    let fetched = 0;
    const poller = createChannelTargetPoller({
      channel: "dev",
      downloadBaseUrl: "https://download.test/releases",
      intervalMs: 60_000,
      fetchImpl: (async () => {
        fetched += 1;
        return pointerResponse(stagingPointer("0.0.3"));
      }) as typeof fetch,
    });
    await poller.refresh();
    poller.start();
    poller.stop();
    expect(poller.get()).toBeUndefined();
    expect(fetched).toBe(0);
  });

  it("follows the exact channel latest pointer", async () => {
    const urls: string[] = [];
    let version = "0.0.3-staging.1.1";
    const poller = createChannelTargetPoller({
      channel: "staging",
      downloadBaseUrl: "https://download.test/releases/",
      intervalMs: 60_000,
      fetchImpl: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return pointerResponse(stagingPointer(version));
      }) as typeof fetch,
    });
    expect(poller.get()).toBeUndefined();
    await poller.refresh();
    expect(poller.get()).toEqual({ channel: "staging", version: "0.0.3-staging.1.1" });
    expect(urls).toEqual(["https://download.test/releases/staging/latest.json"]);

    version = "0.0.3-staging.1.2";
    await poller.refresh();
    expect(poller.get()).toEqual({ channel: "staging", version: "0.0.3-staging.1.2" });
  });

  it("keeps the last known target when polling fails or the pointer is invalid", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => pointerResponse(stagingPointer("0.0.3-staging.1.1")),
      async () => pointerResponse({}, 503),
      async () => {
        throw new Error("network down");
      },
      async () => pointerResponse({ channel: "staging", version: "latest" }),
      async () => pointerResponse(stagingPointer("0.0.3-staging.1.2", "prod")),
      async () => pointerResponse("not-an-object"),
    ];
    const poller = createChannelTargetPoller({
      channel: "staging",
      downloadBaseUrl: "https://download.test/releases",
      intervalMs: 60_000,
      fetchImpl: (async () => {
        const next = responses.shift();
        return next ? next() : pointerResponse(stagingPointer("0.0.3-staging.1.3"));
      }) as typeof fetch,
    });
    await poller.refresh();
    expect(poller.get()?.version).toBe("0.0.3-staging.1.1");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await poller.refresh();
      expect(poller.get()?.version).toBe("0.0.3-staging.1.1");
    }
    await poller.refresh();
    expect(poller.get()?.version).toBe("0.0.3-staging.1.3");
  });

  it("coalesces overlapping refreshes", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => response);
    const poller = createChannelTargetPoller({
      channel: "prod",
      downloadBaseUrl: "https://download.test/releases",
      intervalMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const first = poller.refresh();
    const second = poller.refresh();
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
    release(pointerResponse({ channel: "prod", version: "0.0.3" }));
    await first;
    expect(poller.get()).toEqual({ channel: "prod", version: "0.0.3" });
  });

  it("stops applying responses after stop", async () => {
    const poller = createChannelTargetPoller({
      channel: "prod",
      downloadBaseUrl: "https://download.test/releases",
      intervalMs: 60_000,
      fetchImpl: (async () => pointerResponse({ channel: "prod", version: "0.0.3" })) as typeof fetch,
    });
    poller.stop();
    await poller.refresh();
    expect(poller.get()).toBeUndefined();
  });
});
