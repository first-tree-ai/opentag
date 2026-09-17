import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeExecutionSource } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import {
  RUNTIME_CREDENTIAL_CAPABILITY,
  RUNTIME_PROVIDER_PROXY_CAPABILITY,
  RUNTIME_WEB_TOOLS_CAPABILITY,
} from "../runtime/runtime-credential-frames.js";

const mocks = vi.hoisted(() => ({ relayOpen: vi.fn(), adapterStart: vi.fn() }));

vi.mock("../runtime/runtime-credential-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/runtime-credential-relay.js")>();
  return {
    ...actual,
    RuntimeCredentialRelay: { open: (...args: unknown[]) => mocks.relayOpen(...args) },
  };
});

vi.mock("../runtime/runtime-proxy-loopback-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/runtime-proxy-loopback-adapter.js")>();
  return {
    ...actual,
    RuntimeProxyLoopbackAdapter: { start: (...args: unknown[]) => mocks.adapterStart(...args) },
  };
});

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function fakeConnection() {
  return {
    capabilityVersion: (capability: string): number | undefined =>
      capability === RUNTIME_CREDENTIAL_CAPABILITY ||
      capability === RUNTIME_PROVIDER_PROXY_CAPABILITY ||
      capability === RUNTIME_WEB_TOOLS_CAPABILITY
        ? 1
        : undefined,
    send: vi.fn(async () => undefined),
    subscribeBusinessFrames: vi.fn(() => () => undefined),
    subscribeState: vi.fn(() => () => undefined),
  };
}

function fakeRelay(executionId: string) {
  const abort = new AbortController();
  return {
    executionId,
    providers: [{ provider: "slack" }],
    services: [{ service: "web" as const, scopes: ["web:search" as const, "web:fetch" as const] }],
    signal: abort.signal,
    localHandleFor: () => "local-handle",
    cliMetadataFor: () => ({}),
    openProviderStream: async () => ({}) as never,
    verifyLocalHandle: () => true,
    close: vi.fn(async () => undefined),
    abort,
  };
}

function request(sessionId: string) {
  return {
    agentId: "agent-1",
    placementGeneration: 1,
    sessionId,
    run: {
      runId: `run-${sessionId}`,
      source: { kind: "delivery", deliveryId: "delivery-1", turnId: "turn-1" } as RuntimeExecutionSource,
    },
  };
}

async function manager(home: string): Promise<RuntimeCredentialEnvironmentManager> {
  const created = new RuntimeCredentialEnvironmentManager({
    connection: fakeConnection(),
    home,
    mode: "proxy",
    platform: "darwin",
    serverUrl: "https://server.example.test",
    webTools: {
      extensionPath: "/opt/opentag/client/dist/pi-extensions/web-tools.mjs",
      machineToken: "machine-token",
    },
  });
  return created;
}

describe("RuntimeCredentialEnvironmentManager web endpoints", () => {
  it("opens one fresh short endpoint per execution and never retargets a successor", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-web-manager-"));
    homes.push(home);
    const credentials = await manager(home);
    try {
      const firstRelay = fakeRelay("exec-one");
      mocks.relayOpen.mockResolvedValueOnce(firstRelay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: join(home, "fake-ca.pem"),
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const first = await credentials.prepare(request("session-1"));
      const firstSocket = first.web?.socketPath;
      expect(firstSocket).toBeDefined();
      expect(Buffer.byteLength(firstSocket as string)).toBeLessThan(100);
      // The endpoint is private to the execution and independent of long Session storage paths.
      expect(firstSocket).not.toContain(join(home, "sessions"));
      expect((await lstat(firstSocket as string)).isSocket()).toBe(true);

      const secondRelay = fakeRelay("exec-two");
      mocks.relayOpen.mockResolvedValueOnce(secondRelay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: join(home, "fake-ca.pem"),
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const second = await credentials.prepare(request("session-1"));
      const secondSocket = second.web?.socketPath;
      expect(secondSocket).toBeDefined();
      expect(secondSocket).not.toBe(firstSocket);
      // The predecessor endpoint is gone, so a stale descriptor cannot reach the successor.
      await expect(lstat(firstSocket as string)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(secondSocket as string)).isSocket()).toBe(true);

      // Revocation tears down exactly this execution's endpoint and entry.
      secondRelay.abort.abort();
      expect(credentials.webToolsForSession("session-1")).toBeUndefined();
      await vi.waitFor(async () => {
        await expect(lstat(secondSocket as string)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await credentials.close();
    }
  });

  it("stays closed for business when the Server grants no web scopes", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-web-manager-nogrant-"));
    homes.push(home);
    const credentials = await manager(home);
    try {
      const relay = fakeRelay("exec-nogrant");
      relay.services = [] as never;
      mocks.relayOpen.mockResolvedValueOnce(relay);
      mocks.adapterStart.mockImplementationOnce(async () => ({
        caCertPath: join(home, "fake-ca.pem"),
        connectProxyUrl: "http://127.0.0.1:0",
        slackApiHost: undefined,
        close: vi.fn(async () => undefined),
      }));
      const prepared = await credentials.prepare(request("session-1"));
      expect(prepared.web).toBeUndefined();
      expect(credentials.webToolsForSession("session-1")).toBeUndefined();
    } finally {
      await credentials.close();
    }
  });
});
