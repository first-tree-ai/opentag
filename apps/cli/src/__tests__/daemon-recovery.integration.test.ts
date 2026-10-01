import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientLogBindings,
  type ClientLogger,
  readComputerIdentity,
  storeBoundAccountComputer,
  type UpdaterStateSnapshot,
  writeComputerIdentityAtomically,
} from "@opentag/client";
import {
  negotiateRuntimeCapabilities,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
  type RuntimeCapabilityOffers,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const clientMocks = vi.hoisted(() => ({
  createClientRuntime: vi.fn(),
}));

vi.mock("@opentag/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentag/client")>();
  return { ...original, createClientRuntime: clientMocks.createClientRuntime };
});

import { CHANNEL } from "../build-info.js";
import { runDaemonService } from "../core/daemon/runtime.js";

const homes: string[] = [];
const FUTURE_RUNTIME_CAPABILITY = "runtime.futureCapability";

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("daemon recovery integration", () => {
  it("discovers, installs, hands off, and reconnects after a pre-registration capability rejection", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-daemon-recovery-"));
    homes.push(home);

    const identity = {
      version: 2 as const,
      computerId: "00000000-0000-4000-8000-000000000001",
      serverUrl: "",
    };
    const credential = {
      computerId: "00000000-0000-4000-8000-000000000002",
      installationId: identity.computerId,
      machineToken: `otmc_${"a".repeat(64)}`,
      serverUrl: "",
    };
    const server = await recoveryServer(identity.computerId, credential);
    const boundIdentity = { ...identity, serverUrl: server.url };
    const boundCredential = { ...credential, serverUrl: server.url };
    await storeBoundAccountComputer(boundCredential, home);
    await writeComputerIdentityAtomically(home, boundIdentity);

    const targetVersion = "9.9.9";
    let storedState: UpdaterStateSnapshot | undefined;
    let metadataCalls = 0;
    const installs: string[] = [];
    const refreshes: string[] = [];
    const stateStore = {
      loadState: async () => storedState,
      saveState: async (state: UpdaterStateSnapshot) => {
        storedState = structuredClone(state);
      },
    };
    const fetchFn = vi.fn(async () => {
      metadataCalls += 1;
      await server.oldConnectionClosed;
      return new Response(JSON.stringify({ channel: CHANNEL, version: targetVersion }), {
        headers: { "content-type": "application/json" },
      });
    });

    clientMocks.createClientRuntime.mockImplementation(async (connection) => ({
      run: () => connection.run(),
      stop: () => connection.stop(),
      quiesceForUpdate: () => () => undefined,
      protectedWork: () => ({
        sessionActivities: 0,
        pendingRecoveries: 0,
        custodyTurns: 0,
        activeTurns: 0,
        pendingReports: 0,
        queuedSessionMessages: 0,
        total: 0,
      }),
      runtimeManager: { providerId: () => undefined },
    }));

    const firstResult = await runDaemonService({
      home,
      logger: noopLogger(),
      signals: new EventEmitter() as never,
      autoUpdate: {
        attach: true,
        discovery: true,
        fetchFn,
        installMode: { mode: "portable", root: join(home, "portable"), binDir: join(home, "bin") },
        installTarget: async (target) => {
          installs.push(target);
          server.phase = "current";
        },
        refreshService: async () => {
          refreshes.push("refreshed");
        },
        stateStore,
      },
    });

    expect(firstResult.supervisorRestartRequested).toBe(true);
    expect(metadataCalls).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(installs).toEqual([targetVersion]);
    expect(refreshes).toEqual(["refreshed"]);
    expect(server.registerFrames).toHaveLength(0);
    expect(server.authFrames).toHaveLength(1);
    expect(server.authFrames[0]?.machineToken).toBe(boundCredential.machineToken);
    expect(storedState?.attempts[targetVersion]?.result).toBe("installed");

    const secondSignals = new EventEmitter();
    const secondRun = runDaemonService({
      home,
      logger: noopLogger(),
      signals: secondSignals as never,
      autoUpdate: {
        attach: true,
        discovery: false,
        installMode: { mode: "portable", root: join(home, "portable"), binDir: join(home, "bin") },
        stateStore,
      },
    });
    await vi.waitFor(() => expect(server.registerFrames).toHaveLength(1));
    secondSignals.emit("SIGTERM");
    const secondResult = await secondRun;

    expect(secondResult.supervisorRestartRequested).toBe(false);
    expect(server.authFrames).toHaveLength(2);
    expect(server.authFrames.map((frame) => frame.machineToken)).toEqual([
      boundCredential.machineToken,
      boundCredential.machineToken,
    ]);
    expect(server.registerFrames[0]).toMatchObject({
      installationId: boundIdentity.computerId,
      clientVersion: expect.any(String),
    });
    expect(await readComputerIdentity(home)).toEqual(boundIdentity);
    expect(storedState?.state).toBe("installed");
    expect(storedState?.recoveryStatus).toBeUndefined();

    await server.close();
  });
});

interface RecoveryServer {
  authFrames: Array<Record<string, unknown>>;
  close(): Promise<void>;
  oldConnectionClosed: Promise<void>;
  phase: "old" | "current";
  registerFrames: Array<Record<string, unknown>>;
  url: string;
}

async function recoveryServer(installationId: string, credential: { computerId: string }): Promise<RecoveryServer> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  let resolveOldConnectionClosed!: () => void;
  const oldConnectionClosed = new Promise<void>((resolve) => {
    resolveOldConnectionClosed = resolve;
  });
  const result: RecoveryServer = {
    authFrames: [],
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
    oldConnectionClosed,
    phase: "old",
    registerFrames: [],
    url: "",
  };

  wss.on("connection", (socket) => {
    const phase = result.phase;
    socket.on("close", () => {
      if (phase === "old") resolveOldConnectionClosed();
    });
    socket.on("message", (data) =>
      handleServerFrame(socket, data, phase, result, installationId, credential.computerId),
    );
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  result.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return result;
}

interface RecoverySocket {
  send(data: string): void;
}

interface RecoveryRawData {
  toString(): string;
}

function handleServerFrame(
  socket: RecoverySocket,
  data: RecoveryRawData,
  phase: RecoveryServer["phase"],
  result: RecoveryServer,
  installationId: string,
  computerId: string,
): void {
  const frame = JSON.parse(data.toString()) as Record<string, unknown>;
  switch (frame.type) {
    case "auth":
      handleAuthFrame(socket, frame, phase, result, installationId, computerId);
      return;
    case "computer:register":
      handleRegistrationFrame(socket, frame, phase, result);
      return;
    case "heartbeat":
      handleHeartbeatFrame(socket, frame);
      return;
    default:
      return;
  }
}

function handleAuthFrame(
  socket: RecoverySocket,
  frame: Record<string, unknown>,
  phase: RecoveryServer["phase"],
  result: RecoveryServer,
  installationId: string,
  computerId: string,
): void {
  result.authFrames.push({ ...frame, phase });
  socket.send(
    JSON.stringify({
      type: "auth:result",
      requestId: frame.requestId,
      ok: true,
      computerId,
      installationId,
    }),
  );
  socket.send(
    JSON.stringify({
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
      supportedCapabilities: RUNTIME_SERVER_CAPABILITY_OFFERS,
      requiredClientCapabilities: phase === "old" ? [FUTURE_RUNTIME_CAPABILITY] : [],
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 1_000,
    }),
  );
}

function handleRegistrationFrame(
  socket: RecoverySocket,
  frame: Record<string, unknown>,
  phase: RecoveryServer["phase"],
  result: RecoveryServer,
): void {
  result.registerFrames.push({ ...frame, phase });
  if (phase === "old") return;
  socket.send(
    JSON.stringify({
      type: "computer:register:result",
      requestId: frame.requestId,
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_V2,
      connectionId: randomUUID(),
      negotiatedCapabilities: negotiateRuntimeCapabilities(
        frame.supportedCapabilities as RuntimeCapabilityOffers,
        RUNTIME_SERVER_CAPABILITY_OFFERS,
      ),
    }),
  );
}

function handleHeartbeatFrame(socket: RecoverySocket, frame: Record<string, unknown>): void {
  socket.send(
    JSON.stringify({
      type: "heartbeat:result",
      requestId: frame.requestId,
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_V2,
      connectionId: frame.connectionId,
      serverTime: new Date().toISOString(),
    }),
  );
}

function noopLogger(): ClientLogger {
  return {
    child: () => noopLogger(),
    debug: (_fields: ClientLogBindings, _message: string) => undefined,
    error: (_fields: ClientLogBindings, _message: string) => undefined,
    info: (_fields: ClientLogBindings, _message: string) => undefined,
    warn: (_fields: ClientLogBindings, _message: string) => undefined,
  };
}
