import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDirectInputHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createCodexClientRuntime, probeCodexRuntime, resolveCodexHome } from "../runtime/codex-client-runtime.js";
import { RuntimeConnection } from "../runtime/runtime-connection.js";

const directories: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
const readinessCli = fileURLToPath(new URL("./fixtures/codex-readiness-cli.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createCodexClientRuntime", () => {
  it("D-01 verifies the hosted message tool before advertising runtime readiness", async () => {
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

    expect(probe).toHaveBeenCalledOnce();
    expect(runtime.messageToolAvailable).toBe(true);
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
    expect(runtime.messageToolAvailable).toBe(false);
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

  it("validates the production version, login, App Server, and hosted dynamic-tool contract", async () => {
    const home = await temporaryDirectory("opentag-readiness-home-");
    const codexHome = await temporaryDirectory("opentag-readiness-codex-");
    const environment = { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH };
    await expect(probeCodexRuntime(readinessCli, environment)).resolves.toBeUndefined();
    await expect(
      probeCodexRuntime(readinessCli, { ...environment, CODEX_FIXTURE_VERSION: "codex-cli 0.146.0" }),
    ).rejects.toThrow("Codex 0.147.0 or newer is required");
  });

  it("replays durable reports after restart and rearms an uncertain manifest handoff", async () => {
    const home = await temporaryDirectory("opentag-client-home-");
    const codexHome = resolve(home, "codex-home");
    const seedConnection = runtimeConnection();
    const seed = await createCodexClientRuntime(seedConnection, {
      home,
      clientVersion: "0.0.1",
      codexHome,
      codexCommand: process.execPath,
      environment: { HOME: home, PATH: process.env.PATH },
      probe: async () => undefined,
    });
    const runtimeSnapshot = snapshot();
    await seed.reconciler.reconcile(reconcileRequest(seedConnection.computerId, runtimeSnapshot));
    const recordedInput = delivery(runtimeSnapshot);
    const recordedReport = seed.reportOwner.create({
      deliveryId: recordedInput.deliveryId,
      turnId: "turn-recorded",
      sessionId: recordedInput.sessionId,
      agentId: recordedInput.agentId,
      placementGeneration: recordedInput.placementGeneration,
      outcome: "completed",
      executionEffects: "completed",
      finalText: "previously acknowledged result",
      traceSummary: { lastSequence: 2, droppedEvents: 0 },
    });
    await seed.bindingStore.recordAccepted(recordedInput, computeDirectInputHash(recordedInput), recordedReport.turnId);
    await seed.bindingStore.updateUnresolved(
      recordedInput.agentId,
      recordedInput.sessionId,
      recordedReport.turnId,
      "reporting",
      { report: recordedReport, resultHash: recordedReport.resultHash },
    );
    await seed.bindingStore.recordResult(
      recordedInput.agentId,
      recordedInput.sessionId,
      recordedReport.turnId,
      recordedReport.resultHash,
    );

    const unresolvedInput = {
      ...recordedInput,
      requestId: randomUUID(),
      deliveryId: "delivery-unresolved",
      imMessageId: "message-unresolved",
      imMessageRevision: 1,
    };
    const unresolvedReport = seed.reportOwner.create({
      deliveryId: unresolvedInput.deliveryId,
      turnId: "turn-unresolved",
      sessionId: unresolvedInput.sessionId,
      agentId: unresolvedInput.agentId,
      placementGeneration: unresolvedInput.placementGeneration,
      outcome: "completed",
      executionEffects: "completed",
      finalText: "unresolved result",
      traceSummary: { lastSequence: 3, droppedEvents: 0 },
    });
    await seed.bindingStore.recordAccepted(
      unresolvedInput,
      computeDirectInputHash(unresolvedInput),
      unresolvedReport.turnId,
    );
    await seed.bindingStore.updateUnresolved(
      unresolvedInput.agentId,
      unresolvedInput.sessionId,
      unresolvedReport.turnId,
      "reporting",
      { report: unresolvedReport, resultHash: unresolvedReport.resultHash },
    );
    seed.stop();
    seed.reportOwner.stop();

    const server = await runtimeServer();
    cleanup.push(server.close);
    const connection = runtimeConnection(server.url);
    const receivedReports: TurnReportRequest[] = [];
    let conflictedUncertainHandoff = false;
    let reconcileStatus: unknown;
    let retainedReports: unknown;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: true,
              userId: randomUUID(),
              tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "server:welcome",
              protocolVersion: 1,
              capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imMessageTool: 1 },
              heartbeatIntervalMs: 1_000,
              heartbeatTimeoutMs: 2_000,
            }),
          );
          return;
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
          socket.send(JSON.stringify(reconcileRequest(connection.computerId, runtimeSnapshot)));
          return;
        }
        if (frame.type === "session:reconcile:result") {
          reconcileStatus = frame.status;
          retainedReports = frame.retainedReports;
          return;
        }
        if (frame.type === "turn:report") {
          const receivedReport = frame as unknown as TurnReportRequest;
          receivedReports.push(receivedReport);
          if (!conflictedUncertainHandoff) {
            conflictedUncertainHandoff = true;
            socket.send(
              JSON.stringify({
                type: "turn:report:result",
                requestId: receivedReport.requestId,
                turnId: receivedReport.turnId,
                status: "conflict",
                resultHash: receivedReport.resultHash,
              }),
            );
            socket.send(JSON.stringify(reconcileRequest(connection.computerId, runtimeSnapshot)));
            return;
          }
          socket.send(
            JSON.stringify({
              type: "turn:report:result",
              requestId: receivedReport.requestId,
              turnId: receivedReport.turnId,
              status: "recorded",
              resultHash: receivedReport.resultHash,
            }),
          );
        }
      });
    });
    const recovered = await createCodexClientRuntime(connection, {
      home,
      clientVersion: "0.0.1",
      codexHome,
      codexCommand: process.execPath,
      environment: { HOME: home, PATH: process.env.PATH },
      probe: async () => undefined,
    });
    const running = recovered.run();
    await vi.waitFor(() => expect(reconcileStatus).toBe("recovery_required"));
    await vi.waitFor(() =>
      expect(retainedReports).toEqual([
        {
          deliveryId: unresolvedReport.deliveryId,
          turnId: unresolvedReport.turnId,
          placementGeneration: unresolvedReport.placementGeneration,
          resultHash: unresolvedReport.resultHash,
        },
        {
          deliveryId: recordedReport.deliveryId,
          turnId: recordedReport.turnId,
          placementGeneration: recordedReport.placementGeneration,
          resultHash: recordedReport.resultHash,
        },
      ]),
    );
    await vi.waitFor(() => expect(receivedReports).toEqual([unresolvedReport, unresolvedReport, recordedReport]));
    await vi.waitFor(async () => {
      expect(
        (await recovered.bindingStore.read(unresolvedInput.agentId, unresolvedInput.sessionId))?.unresolvedTurn,
      ).toBeUndefined();
    });
    const recorded = (
      await recovered.bindingStore.read(unresolvedInput.agentId, unresolvedInput.sessionId)
    )?.recentRecordedInputs.map((entry) => entry.report);
    expect(recorded).toEqual([recordedReport, unresolvedReport]);
    recovered.stop();
    await running;
  });
});

function runtimeConnection(serverUrl = "http://127.0.0.1:3000"): RuntimeConnection {
  return new RuntimeConnection({
    arch: "arm64",
    clientVersion: "0.0.1",
    computer: {
      version: 1,
      computerId: randomUUID(),
      serverUrl,
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

async function runtimeServer(): Promise<{ close(): Promise<void>; url: string; wss: WebSocketServer }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolveListen) => http.listen(0, "127.0.0.1", resolveListen));
  const address = http.address() as AddressInfo;
  return {
    wss,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await new Promise<void>((resolveClose, reject) =>
        http.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
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
    imMessageRevision: 1,
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
