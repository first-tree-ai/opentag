import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshot,
  SessionReconcileRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexClientRuntime, resolveCodexHome } from "../runtime/codex-client-runtime.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createCodexClientRuntime", () => {
  it("D-01 defers provider probing until delivery preflight", async () => {
    const home = await temporaryDirectory("opentag-client-home-");
    const codexHome = resolve(home, "not-created-yet", "codex-home");
    const probe = vi.fn<(command: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>>(
      async () => undefined,
    );
    const connection = runtimeConnection();
    const runtime = await createCodexClientRuntime(connection, {
      home,
      clientVersion: "0.0.1",
      codexHome,
      codexCommand: process.execPath,
      environment: {
        HOME: home,
        PATH: process.env.PATH,
        OPENTAG_ACCESS_TOKEN: "canary-opentag-token",
        OPENAI_API_KEY: "canary-provider-token",
      },
      probe,
    });

    expect(probe).not.toHaveBeenCalled();
    const runtimeSnapshot = snapshot();
    const reconcile = reconcileRequest(connection.computerId, runtimeSnapshot);
    await expect(runtime.reconciler.reconcile(reconcile)).resolves.toMatchObject({ status: "ready" });
    await expect(runtime.custody.accept(delivery(runtimeSnapshot))).resolves.toMatchObject({
      result: { status: "accepted" },
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[1]).toMatchObject({ HOME: home, CODEX_HOME: await realpath(codexHome) });
    expect(JSON.stringify(probe.mock.calls[0]?.[1])).not.toContain("canary");
    expect(runtime.reconciler).toBeDefined();
    runtime.stop();
    runtime.reportOwner.stop();
  });

  it("C-27 keeps the daemon available and rejects delivery when Codex is not installed", async () => {
    const home = await temporaryDirectory("opentag-client-home-");
    const connection = runtimeConnection();
    const probe = vi.fn(async () => undefined);
    const runtime = await createCodexClientRuntime(connection, {
      home,
      clientVersion: "0.0.1",
      codexHome: resolve(home, "missing-codex-home"),
      codexCommand: resolve(home, "missing-codex"),
      environment: { HOME: home, PATH: process.env.PATH },
      probe,
    });

    expect(probe).not.toHaveBeenCalled();
    const runtimeSnapshot = snapshot();
    await runtime.reconciler.reconcile(reconcileRequest(connection.computerId, runtimeSnapshot));
    await expect(runtime.custody.accept(delivery(runtimeSnapshot))).resolves.toMatchObject({
      result: { status: "rejected", reason: "provider_unavailable" },
    });
    expect(probe).not.toHaveBeenCalled();
    runtime.stop();
    runtime.reportOwner.stop();
  });

  it("uses HOME when CODEX_HOME is absent", () => {
    expect(resolveCodexHome({ HOME: "/provider-home" })).toBe(resolve("/provider-home/.codex"));
  });
});

function runtimeConnection(): RuntimeConnection {
  return new RuntimeConnection({
    arch: "arm64",
    clientVersion: "0.0.1",
    computer: {
      version: 1,
      computerId: randomUUID(),
      serverUrl: "http://127.0.0.1:3000",
      userId: randomUUID(),
    },
    displayName: "test",
    instanceId: randomUUID(),
    platform: "darwin",
    tokenProvider: {
      getAccessTokenLease: async () => ({
        accessToken: "unused",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    },
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function reconcileRequest(computerId: string, runtime: EffectiveRuntimeSnapshot): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
}

function delivery(runtime: EffectiveRuntimeSnapshot): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "hello" },
    runtime,
  };
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}
