import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  negotiateRuntimeCapabilities,
  PROVIDER_READINESS_V1_HEADER,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V1,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { OpenTagApiError } from "../api.js";
import { type RuntimeBusinessFrame, RuntimeConnection } from "../runtime/runtime-connection.js";
import { RuntimeStorageError } from "../storage/durable-file.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((close) => close())));

describe("RuntimeConnection", () => {
  it("validates queue limits, readiness leases, capability expiry, and registration waiters", async () => {
    const baseOptions = {
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2 as const, computerId: randomUUID(), serverUrl: "http://127.0.0.1:8000" },
      displayName: "workstation",
      instanceId: randomUUID(),
      machineToken: "machine-token",
      platform: "linux" as const,
    };
    for (const priority of ["control", "result", "report", "trace"] as const) {
      expect(() => new RuntimeConnection({ ...baseOptions, queueLimits: { [priority]: 0 } })).toThrow(
        `Runtime ${priority} queue limit must be a positive safe integer`,
      );
    }
    let currentTime = 10_000;
    const connection = new RuntimeConnection({ ...baseOptions, queueLimits: { trace: 1 }, now: () => currentTime });
    expect(connection.state).toBe("stopped");
    expect(connection.installationId).toBe(baseOptions.computer.computerId);
    expect(connection.instanceId).toBe(baseOptions.instanceId);
    expect(connection.supportsCapability("runtime.imDelivery")).toBe(false);
    expect(connection.capabilityVersion("runtime.imDelivery")).toBeUndefined();
    for (const setter of [
      () => connection.setVerifiedCapabilities({ imCredentialGrant: 1 }, 0),
      () => connection.setVerifiedCapabilities({ imCredentialGrant: 1 }, RUNTIME_CLIENT_CAPABILITY_TTL_MS + 1),
      () => connection.setProviderReadiness({ provider: "codex", status: "ready" }, 0),
      () => connection.setImCliReadiness({ provider: "feishu", status: "ready" }, 0),
    ]) {
      expect(setter).toThrow(/validity is invalid/);
    }
    connection.setVerifiedCapabilities({ imCredentialGrant: 1 }, 1);
    connection.setProviderReadiness({ provider: "codex", status: "ready" }, 1);
    connection.setImCliReadiness({ provider: "feishu", status: "ready" }, 1);
    currentTime = 10_002;
    const aborted = new AbortController();
    aborted.abort();
    await expect(connection.whenRegistered(aborted.signal)).rejects.toMatchObject({ code: "aborted" });
    connection.stop();
    await expect(connection.whenRegistered()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("covers registration state capabilities and waiter cancellation with a controlled socket", async () => {
    const socket = new ControlledWebSocket();
    let currentTime = Date.now();
    const connection = new RuntimeConnection({ ...controlledOptions(socket), now: () => currentTime });
    connection.setVerifiedCapabilities({ imCredentialGrant: 1 }, 1);
    currentTime += 2;
    const stateListener = vi.fn((state: string) => {
      if (state === "registered") throw new Error("listener failure");
    });
    const unsubscribe = connection.subscribeState(stateListener);
    const waiterController = new AbortController();
    const waiter = connection.whenRegistered(waiterController.signal);
    waiterController.abort();
    await expect(waiter).rejects.toMatchObject({ code: "aborted" });
    const registeredWaiter = connection.whenRegistered();
    const running = connection.run();
    await registerControlled(connection, socket);
    await registeredWaiter;
    expect(socket.frame("computer:register")).toMatchObject({ capabilities: { imCredentialGrant: 0 } });
    expect(connection.supportsCapability("runtime.imDelivery")).toBe(true);
    expect(connection.capabilityVersion("runtime.imDelivery")).toBe(2);
    expect(await connection.whenRegistered()).toBeUndefined();
    expect(stateListener).toHaveBeenCalledWith("registered");
    expect(unsubscribe()).toBe(true);
    connection.stop();
    await running;
  });

  it("handles unavailable, aborted, malformed, and fenced outbound sends", async () => {
    const stopped = controlledConnection(new ControlledWebSocket(), { trace: 2 });
    await expect(stopped.send({ type: "before" })).rejects.toMatchObject({ code: "unavailable" });
    const socket = new ControlledWebSocket();
    const connection = controlledConnection(socket, { trace: 2 });
    const running = connection.run();
    await registerControlled(connection, socket);
    const aborted = new AbortController();
    aborted.abort();
    await expect(connection.send({ type: "aborted" }, { signal: aborted.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    await expect(connection.send(null)).rejects.toMatchObject({ code: "unavailable" });
    await expect(connection.send(["invalid"])).rejects.toMatchObject({ code: "unavailable" });
    await expect(connection.send({ type: "stale", connectionId: randomUUID() })).rejects.toMatchObject({
      code: "unavailable",
    });
    const cyclic: Record<string, unknown> = { type: "cyclic" };
    cyclic.self = cyclic;
    await expect(connection.send(cyclic)).rejects.toMatchObject({ code: "frame_too_large" });
    await expect(connection.send({ type: "expired" }, { deadline: Date.now() - 1 })).rejects.toMatchObject({
      code: "deadline",
    });
    await expect(connection.send({ type: "priority" }, { priority: "bad" as never })).rejects.toMatchObject({
      code: "overflow",
    });
    connection.stop();
    await running;
  });

  it("rejects invalid handshakes, authentication, registration, and capability requirements", async () => {
    const scenarios: Array<{ name: string; respond: (socket: WebSocket, frame: Record<string, unknown>) => void }> = [
      {
        name: "unmatched auth",
        respond: (socket, _frame) =>
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: randomUUID(),
              ok: true,
              computerId: randomUUID(),
              installationId: randomUUID(),
            }),
          ),
      },
      {
        name: "auth rejected",
        respond: (socket, frame) =>
          socket.send(
            JSON.stringify({
              type: "auth:result",
              requestId: frame.requestId,
              ok: false,
              errorCode: "AUTH_INVALID_TOKEN",
            }),
          ),
      },
      {
        name: "missing capability",
        respond: (socket, frame) => {
          const { "runtime.imDelivery": _omitted, ...supportedCapabilities } = RUNTIME_SERVER_CAPABILITY_OFFERS;
          completeAuth(socket, frame, {
            ...welcome(),
            requiredClientCapabilities: ["runtime.imDelivery"],
            supportedCapabilities,
          });
        },
      },
    ];
    for (const scenario of scenarios) {
      const server = await runtimeServer();
      cleanup.push(server.close);
      server.wss.on("connection", (socket) => {
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.type === "auth") scenario.respond(socket, frame);
        });
      });
      const connection = new RuntimeConnection({
        arch: "x64",
        clientVersion: "0.0.1",
        computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
        displayName: "workstation",
        instanceId: randomUUID(),
        platform: "linux",
        machineToken: "machine-token",
      });
      await expect(connection.run()).rejects.toThrow(
        scenario.name === "unmatched auth"
          ? "unmatched auth result"
          : scenario.name === "auth rejected"
            ? "AUTH_INVALID_TOKEN"
            : "Required runtime capabilities are unavailable",
      );
    }
  });

  it("logs distinct redacted reasons for fatal protocol rejection", async () => {
    const scenarios = [
      {
        send: (socket: ControlledWebSocket, _auth: Record<string, unknown>) =>
          socket.receive({
            type: "auth:result",
            requestId: randomUUID(),
            ok: true,
            computerId: randomUUID(),
            installationId: randomUUID(),
          }),
        expectedError: "unmatched auth result",
      },
      {
        send: (socket: ControlledWebSocket, auth: Record<string, unknown>) =>
          socket.receive({
            type: "error",
            requestId: auth.requestId,
            code: "AUTH_INVALID_TOKEN",
            message: "Authorization: Bearer close-secret",
          }),
        expectedError: "Authorization: Bearer close-secret",
      },
    ];
    const reasons: unknown[] = [];
    for (const scenario of scenarios) {
      const socket = new ControlledWebSocket();
      const logs: RecordedLog[] = [];
      const connection = new RuntimeConnection({
        ...controlledOptions(socket),
        logger: recordingLogger(logs),
      });
      const running = connection.run();
      await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
      socket.open();
      await vi.waitFor(() => expect(socket.frame("auth")).toBeDefined());
      scenario.send(socket, socket.frame("auth") ?? {});
      await expect(running).rejects.toThrow(scenario.expectedError);
      const rejection = logs.find((entry) => entry.message === "Runtime connection was rejected");
      expect(rejection).toMatchObject({
        level: "error",
        fields: { attempt: 1, category: "protocol", state: "authenticating" },
      });
      reasons.push(rejection?.fields.reason);
    }
    expect(reasons[0]).toBe("The server returned an unmatched auth result");
    expect(reasons[1]).toBe("Authorization: [REDACTED]");
    expect(reasons[1]).not.toContain("close-secret");
    expect(reasons[0]).not.toBe(reasons[1]);
  });

  it("rejects malformed and oversized inbound frames and stale business fences", async () => {
    const cases: Array<{ label: string; receive: (socket: ControlledWebSocket) => void; parser?: boolean }> = [
      { label: "invalid JSON", receive: (socket) => socket.receiveData("not-json") },
      { label: "oversized", receive: (socket) => socket.receiveData(Buffer.alloc(RUNTIME_MAX_FRAME_BYTES + 1)) },
      { label: "invalid envelope", receive: (socket) => socket.receiveData("{}") },
    ];
    for (const current of cases) {
      const socket = new ControlledWebSocket();
      const connection = controlledConnection(socket, { trace: 2 });
      const running = connection.run();
      await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
      socket.open();
      await vi.waitFor(() => expect(socket.frame("auth")).toBeDefined());
      current.receive(socket);
      await expect(running).rejects.toThrow(
        current.label === "invalid JSON"
          ? "invalid runtime frame"
          : current.label === "oversized"
            ? "oversized runtime frame"
            : "invalid runtime frame",
      );
    }

    const socket = new ControlledWebSocket();
    const connection = new RuntimeConnection({
      ...controlledOptions(socket),
      parseBusinessFrame: (value) =>
        (value as { type: string }).type === "test:event" ? (value as RuntimeBusinessFrame) : undefined,
    });
    const running = connection.run();
    await registerControlled(connection, socket);
    socket.receive({ type: "test:event", connectionId: randomUUID() });
    await expect(running).rejects.toThrow("stale runtime connection fence");
  });

  it("maps API and credential failures to actionable fatal connection errors", async () => {
    const apiConnection = new RuntimeConnection({
      ...controlledOptions(new ControlledWebSocket()),
      webSocketFactory: () => {
        throw new OpenTagApiError("AUTH_INVALID_TOKEN", "credential", "access token was revoked");
      },
    });
    await expect(apiConnection.run()).rejects.toThrow("access token was revoked; run opentag connect again");

    const credentialConnection = new RuntimeConnection({
      ...controlledOptions(new ControlledWebSocket()),
      webSocketFactory: () => {
        throw new Error("The runtime CLI is not logged in");
      },
    });
    await expect(credentialConnection.run()).rejects.toThrow(
      "The runtime CLI is not logged in; run opentag connect first",
    );
  });

  it("uses the default retry timer after a transient factory failure", async () => {
    const socket = new ControlledWebSocket();
    let attempts = 0;
    const factory = () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary factory failure");
      return socket as unknown as WebSocket;
    };
    const connection = new RuntimeConnection({
      ...controlledOptions(socket),
      jitter: () => 0,
      webSocketFactory: factory,
    });
    const running = connection.run();
    await vi.waitFor(() => expect(attempts).toBe(2));
    await registerControlled(connection, socket);
    connection.stop();
    await running;
    expect(attempts).toBe(2);
  });

  it("covers failed queued sends, expiry, abort, and socket-wide rejection", async () => {
    const socket = new ControlledWebSocket();
    let currentTime = 10_000;
    const scheduler = new ManualScheduler(() => currentTime);
    const connection = new RuntimeConnection({
      ...controlledOptions(socket),
      now: () => currentTime,
      scheduler,
      queueLimits: { trace: 2 },
    });
    const running = connection.run();
    await registerControlled(connection, socket);
    socket.autoFlush = false;
    const first = connection.send({ type: "test:first" }, { priority: "result" });
    const abortController = new AbortController();
    const aborted = connection.send({ type: "test:aborted" }, { priority: "result", signal: abortController.signal });
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    socket.releaseNextSend();
    await first;

    const expiring = connection.send({ type: "test:expiring" }, { priority: "result", deadline: currentTime + 1 });
    currentTime += 1;
    scheduler.runDue();
    await expect(expiring).rejects.toMatchObject({ code: "deadline" });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    connection.stop();
    await running;

    const socketForReject = new ControlledWebSocket();
    const rejectConnection = controlledConnection(socketForReject, { trace: 2 });
    const rejectRunning = rejectConnection.run();
    await registerControlled(rejectConnection, socketForReject);
    socketForReject.autoFlush = false;
    const inFlight = rejectConnection.send({ type: "test:inflight" });
    const queued = rejectConnection.send({ type: "test:queued" });
    socketForReject.close(1006);
    await expect(inFlight).rejects.toMatchObject({ code: "unavailable" });
    await expect(queued).rejects.toMatchObject({ code: "unavailable" });
    rejectConnection.stop();
    await rejectRunning;
  });

  it("covers direct-send failures, default business parsing, and raw data variants", async () => {
    const hugeSocket = new ControlledWebSocket();
    let hugeConnection!: RuntimeConnection;
    hugeSocket.on("open", () => undefined);
    hugeConnection = new RuntimeConnection({
      ...controlledOptions(hugeSocket),
      machineToken: "x".repeat(RUNTIME_MAX_FRAME_BYTES),
      waitForRetry: async (_delay) => hugeConnection.stop(),
    });
    const hugeRunning = hugeConnection.run();
    await vi.waitFor(() => expect(hugeSocket.listenerCount("open")).toBeGreaterThan(0));
    hugeSocket.open();
    await hugeRunning;

    const unavailableSocket = new ControlledWebSocket();
    let unavailableConnection!: RuntimeConnection;
    unavailableSocket.on("open", () => {
      unavailableSocket.readyState = WebSocket.CLOSED;
    });
    unavailableConnection = new RuntimeConnection({
      ...controlledOptions(unavailableSocket),
      waitForRetry: async (_delay) => unavailableConnection.stop(),
    });
    const unavailableRunning = unavailableConnection.run();
    await vi.waitFor(() => expect(unavailableSocket.listenerCount("open")).toBeGreaterThan(0));
    unavailableSocket.open();
    await unavailableRunning;

    const socket = new ControlledWebSocket();
    const connection = new RuntimeConnection({ ...controlledOptions(socket) });
    const running = connection.run();
    const connectionId = await registerControlled(connection, socket);
    const business = {
      type: "turn:report:result",
      requestId: randomUUID(),
      turnId: "turn-1",
      status: "recorded",
      resultHash: "a".repeat(64),
      connectionId,
    };
    const received: RuntimeBusinessFrame[] = [];
    const allFramesReceived = new Promise<void>((resolve) => {
      connection.subscribeBusinessFrames((frame) => {
        received.push(frame);
        if (received.length === 3) resolve();
      });
    });
    const encoded = new TextEncoder().encode(JSON.stringify(business));
    socket.receiveData(encoded.buffer);
    socket.receiveData([Buffer.from(JSON.stringify(business))]);
    socket.receiveData(JSON.stringify(business));
    await allFramesReceived;
    expect(received).toHaveLength(3);
    connection.stop();
    await running;
  });

  it("rejects a retry wait failure instead of looping forever", async () => {
    const connection = new RuntimeConnection({
      ...controlledOptions(new ControlledWebSocket()),
      webSocketFactory: () => {
        throw new Error("transport setup failed");
      },
      waitForRetry: async () => {
        throw new Error("retry scheduler failed");
      },
    });
    await expect(connection.run()).rejects.toThrow("retry scheduler failed");
  });

  it("covers parser failures and out-of-order protocol frames after registration", async () => {
    const parserSocket = new ControlledWebSocket();
    const parserConnection = new RuntimeConnection({
      ...controlledOptions(parserSocket),
      parseBusinessFrame: () => {
        throw new Error("parser failed");
      },
    });
    const parserRunning = parserConnection.run();
    const parserConnectionId = await registerControlled(parserConnection, parserSocket);
    parserSocket.receive({ type: "unknown:business", connectionId: parserConnectionId });
    await expect(parserRunning).rejects.toThrow("invalid runtime frame");

    const orderedSocket = new ControlledWebSocket();
    const orderedConnection = controlledConnection(orderedSocket, { trace: 2 });
    const orderedRunning = orderedConnection.run();
    await vi.waitFor(() => expect(orderedSocket.listenerCount("open")).toBeGreaterThan(0));
    orderedSocket.open();
    await vi.waitFor(() => expect(orderedSocket.frame("auth")).toBeDefined());
    const auth = orderedSocket.frame("auth");
    orderedSocket.receive({
      type: "auth:result",
      requestId: auth?.requestId,
      ok: true,
      computerId: randomUUID(),
      installationId: randomUUID(),
    });
    orderedSocket.receive(welcome(1_000, 2_000));
    await vi.waitFor(() => expect(orderedSocket.frame("computer:register")).toBeDefined());
    orderedSocket.receive({ type: "auth:result", requestId: randomUUID(), ok: false, errorCode: "INTERNAL_ERROR" });
    await expect(orderedRunning).rejects.toThrow("out of order");
  });

  it("delivers advertised channel targets only when the capability was negotiated", async () => {
    for (const negotiated of ["full", "without-channel-target"] as const) {
      const socket = new ControlledWebSocket();
      const observed: unknown[] = [];
      const connection = new RuntimeConnection({
        ...controlledOptions(socket),
        onChannelTarget: (target) => observed.push(target),
      });
      const running = connection.run();
      await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
      socket.open();
      await vi.waitFor(() => expect(socket.frame("auth")).toBeDefined());
      const auth = socket.frame("auth");
      socket.receive({
        type: "auth:result",
        requestId: auth?.requestId,
        ok: true,
        computerId: randomUUID(),
        installationId: randomUUID(),
      });
      const baseWelcome = welcome(10, 2_000);
      const { "runtime.channelTarget": _omitted, ...legacyServerCapabilities } = RUNTIME_SERVER_CAPABILITY_OFFERS;
      const supportedCapabilities =
        negotiated === "without-channel-target" ? legacyServerCapabilities : RUNTIME_SERVER_CAPABILITY_OFFERS;
      const serverWelcome =
        negotiated === "without-channel-target" ? { ...baseWelcome, supportedCapabilities } : baseWelcome;
      socket.receive(serverWelcome);
      await vi.waitFor(() => expect(socket.frame("computer:register")).toBeDefined());
      const register = socket.frame("computer:register");
      const connectionId = randomUUID();
      const negotiatedCapabilities = negotiateRuntimeCapabilities(RUNTIME_CLIENT_CAPABILITY_OFFERS, {
        ...supportedCapabilities,
      });
      socket.receive({
        type: "computer:register:result",
        requestId: register?.requestId,
        ok: true,
        protocolVersion: RUNTIME_PROTOCOL_V2,
        connectionId,
        negotiatedCapabilities,
      });
      await connection.whenRegistered();
      await vi.waitFor(() => expect(socket.frame("heartbeat")).toBeDefined());
      const heartbeat = socket.frame("heartbeat");
      socket.receive({
        type: "heartbeat:result",
        requestId: heartbeat?.requestId,
        ok: true,
        serverTime: new Date().toISOString(),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        connectionId,
        channelTarget: { channel: "staging", version: "0.0.3-staging.1.1" },
      });
      await vi.waitFor(() => expect(socket.listenerCount("heartbeat") >= 0).toBe(true));
      await vi.waitFor(() => {
        if (negotiated === "full") {
          expect(observed).toEqual([{ channel: "staging", version: "0.0.3-staging.1.1" }]);
        }
      });
      if (negotiated === "without-channel-target") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(observed).toEqual([]);
      }
      connection.stop();
      await running;
    }
  });

  it("rejects unmatched, failed, and legacy-mismatched registration results", async () => {
    for (const scenario of [
      {
        build: (frame: Record<string, unknown>) => ({ ...registrationResult(frame), requestId: randomUUID() }),
        message: "unmatched registration result",
      },
      {
        build: (frame: Record<string, unknown>) => ({
          type: "computer:register:result",
          requestId: frame.requestId,
          ok: false,
          errorCode: "INTERNAL_ERROR",
          protocolVersion: RUNTIME_PROTOCOL_V2,
        }),
        message: "registration failed",
      },
    ]) {
      const socket = new ControlledWebSocket();
      const connection = controlledConnection(socket, { trace: 2 });
      const running = connection.run();
      await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
      socket.open();
      await vi.waitFor(() => expect(socket.frame("auth")).toBeDefined());
      const auth = socket.frame("auth");
      socket.receive({
        type: "auth:result",
        requestId: auth?.requestId,
        ok: true,
        computerId: randomUUID(),
        installationId: randomUUID(),
      });
      socket.receive(welcome(1_000, 2_000));
      await vi.waitFor(() => expect(socket.frame("computer:register")).toBeDefined());
      socket.receive(scenario.build(socket.frame("computer:register") ?? {}));
      await expect(running).rejects.toThrow(scenario.message);
    }

    const firstSocket = new ControlledWebSocket();
    const secondSocket = new ControlledWebSocket();
    let connection!: RuntimeConnection;
    let attempts = 0;
    connection = new RuntimeConnection({
      ...controlledOptions(firstSocket),
      webSocketFactory: () => {
        attempts += 1;
        return (attempts === 1 ? firstSocket : secondSocket) as unknown as WebSocket;
      },
      waitForRetry: async () => connection.stop(),
    });
    const running = connection.run();
    await vi.waitFor(() => expect(firstSocket.listenerCount("open")).toBeGreaterThan(0));
    firstSocket.open();
    await vi.waitFor(() => expect(firstSocket.frame("auth")).toBeDefined());
    const auth = firstSocket.frame("auth");
    firstSocket.receive({
      type: "error",
      requestId: auth?.requestId,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      message: "v1 fallback",
    });
    await vi.waitFor(() => expect(secondSocket.listenerCount("open")).toBeGreaterThan(0));
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.frame("auth")).toBeDefined());
    const legacyAuth = secondSocket.frame("auth");
    secondSocket.receive({
      type: "auth:result",
      requestId: legacyAuth?.requestId,
      ok: true,
      computerId: randomUUID(),
      installationId: randomUUID(),
    });
    secondSocket.receive(welcome(1_000, 2_000, RUNTIME_PROTOCOL_V1));
    await vi.waitFor(() => expect(secondSocket.frame("computer:register")).toBeDefined());
    secondSocket.receive({
      type: "computer:register:result",
      requestId: secondSocket.frame("computer:register")?.requestId,
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_V2,
      connectionId: randomUUID(),
      negotiatedCapabilities: negotiateRuntimeCapabilities(
        RUNTIME_CLIENT_CAPABILITY_OFFERS,
        RUNTIME_SERVER_CAPABILITY_OFFERS,
      ),
    });
    await expect(running).rejects.toThrow("legacy registration");
    expect(attempts).toBe(2);
  });

  it("rejects stale and failed heartbeat results", async () => {
    for (const scenario of ["stale", "failed"] as const) {
      const socket = new ControlledWebSocket();
      const connection = controlledConnection(socket, { trace: 2 });
      const running = connection.run();
      await registerControlled(connection, socket, welcome(10, 1_000));
      await vi.waitFor(() => expect(socket.frame("heartbeat")).toBeDefined());
      const heartbeat = socket.frame("heartbeat") ?? {};
      socket.receive({
        type: "heartbeat:result",
        requestId: heartbeat.requestId,
        ok: scenario !== "failed",
        serverTime: new Date().toISOString(),
        ...(scenario === "failed" ? { errorCode: "INTERNAL_ERROR" } : {}),
        protocolVersion: RUNTIME_PROTOCOL_V2,
        connectionId: scenario === "failed" ? heartbeat.connectionId : randomUUID(),
      });
      await expect(running).rejects.toThrow(scenario === "failed" ? "heartbeat failed" : "stale heartbeat fence");
    }
  });
  it("authenticates, registers a fresh instance, heartbeats, and stops without reconnecting", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const frames: Array<Record<string, unknown>> = [];
    const computerId = randomUUID();
    const instanceId = randomUUID();
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket, request) => {
      expect(request.headers[PROVIDER_READINESS_V1_HEADER]).toBe("1");
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "auth") {
          completeAuth(socket, frame, {
            ...welcome(),
            providerReadiness: { version: 1, providers: ["codex"] },
          });
        } else if (frame.type === "computer:register") {
          completeRegistration(socket, frame);
        } else if (frame.type === "heartbeat") {
          completeHeartbeat(socket, frame);
          connection.stop();
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId, serverUrl: server.url },
      displayName: "workstation",
      instanceId,
      jitter: () => 0,
      platform: "linux",
      machineToken: "machine-token",
    });
    connection.setProviderReadiness({ provider: "codex", status: "ready" });
    connection.setProviderReadiness({ provider: "claude-code", status: "ready" });

    await connection.run();
    expect(frames.map((frame) => frame.type)).toEqual(["auth", "computer:register", "heartbeat"]);
    expect(frames[0]).toMatchObject({
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
    });
    const register = frames[1];
    expect(register).toMatchObject({ installationId: computerId, displayName: "workstation", platform: "linux" });
    expect(register).toMatchObject({ providerReadiness: [{ provider: "codex", status: "ready" }] });
    expect(register).not.toEqual(
      expect.objectContaining({ providerReadiness: expect.arrayContaining([{ provider: "claude-code" }]) }),
    );
    expect(register?.instanceId).toBe(instanceId);
    expect(frames[2]).toMatchObject({ providerReadiness: [{ provider: "codex", status: "ready" }] });
  });

  it("keeps readiness fields off v1 frames when an older Server does not acknowledge them", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const frames: Array<Record<string, unknown>> = [];
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "auth") {
          if (frame.protocolVersion === RUNTIME_PROTOCOL_V2) {
            socket.send(
              JSON.stringify({
                type: "error",
                requestId: frame.requestId,
                code: "PROTOCOL_VERSION_UNSUPPORTED",
                message: "The test Server supports runtime protocol v1 only",
              }),
            );
            socket.close(4400, "Protocol version unsupported");
            return;
          }
          completeAuth(socket, frame, welcome(10, 1_000, RUNTIME_PROTOCOL_V1));
        }
        if (frame.type === "computer:register") {
          socket.send(JSON.stringify({ type: "computer:register:result", requestId: frame.requestId, ok: true }));
        }
        if (frame.type === "heartbeat") {
          socket.send(
            JSON.stringify({
              type: "heartbeat:result",
              requestId: frame.requestId,
              ok: true,
              serverTime: new Date().toISOString(),
            }),
          );
          connection.stop();
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });
    connection.setProviderReadiness({ provider: "codex", status: "ready" });

    await connection.run();
    expect(frames.find((frame) => frame.type === "computer:register")).not.toHaveProperty("providerReadiness");
    expect(frames.find((frame) => frame.type === "heartbeat")).not.toHaveProperty("providerReadiness");
  });

  it("keeps negotiated readiness heartbeats fresh past the TTL while a lease owns admission", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const heartbeats: Array<Record<string, unknown>> = [];
    let currentTime = Date.now();
    let releaseReadiness!: () => void;
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, { ...welcome(), providerReadiness: { version: 1, providers: ["codex"] } });
        }
        if (frame.type === "computer:register") {
          expect(frame).toMatchObject({ providerReadiness: [{ provider: "codex", status: "ready" }] });
          currentTime += RUNTIME_CLIENT_CAPABILITY_TTL_MS + 1;
          completeRegistration(socket, frame);
        }
        if (frame.type === "heartbeat") {
          heartbeats.push(frame);
          if (heartbeats.length === 1) releaseReadiness();
          completeHeartbeat(socket, frame);
          if (heartbeats.length === 2) connection.stop();
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      now: () => currentTime,
      platform: "linux",
      machineToken: "machine-token",
    });
    releaseReadiness = connection.leaseProviderReadiness({ provider: "codex", status: "ready" });

    await connection.run();
    expect(heartbeats[0]).toMatchObject({ providerReadiness: [{ provider: "codex", status: "ready" }] });
    expect(heartbeats[1]).toMatchObject({ providerReadiness: [] });
  });

  it("fails closed on a rejected machine credential without an Account-auth fallback", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let connections = 0;
    server.wss.on("connection", (socket) => {
      connections += 1;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          socket.send(
            JSON.stringify({
              type: "error",
              requestId: frame.requestId,
              code: "AUTH_INVALID_TOKEN",
              message: "machine credential revoked",
            }),
          );
        }
      });
    });
    const connection = new RuntimeConnection({
      arch: "arm64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      machineToken: "revoked-machine-token",
      platform: "darwin",
    });

    await expect(connection.run()).rejects.toThrow("machine credential revoked");
    expect(connections).toBe(1);
  });

  it("reuses a process instance across reconnects and resets backoff after registration", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const instanceId = randomUUID();
    const registeredInstanceIds: unknown[] = [];
    const retryDelays: number[] = [];
    let connections = 0;
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      connections += 1;
      if (connections <= 2) {
        socket.terminate();
        return;
      }
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(1_000, 2_000));
        } else if (frame.type === "computer:register") {
          registeredInstanceIds.push(frame.instanceId);
          completeRegistration(socket, frame);
          if (connections === 3) {
            setTimeout(() => socket.terminate(), 5);
          } else {
            connection.stop();
          }
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId,
      jitter: () => 1,
      platform: "linux",
      machineToken: "machine-token",
      waitForRetry: async (milliseconds) => {
        retryDelays.push(milliseconds);
      },
    });

    await connection.run();
    expect(registeredInstanceIds).toEqual([instanceId, instanceId]);
    expect(retryDelays).toEqual([1_000, 2_000, 1_000]);
  });

  it("uses a distinct instance identity for another daemon process", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const instanceIds = [randomUUID(), randomUUID()];
    const registeredInstanceIds: unknown[] = [];
    let active: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(1_000, 2_000));
        } else if (frame.type === "computer:register") {
          registeredInstanceIds.push(frame.instanceId);
          completeRegistration(socket, frame);
          active.stop();
        }
      });
    });
    for (const instanceId of instanceIds) {
      active = new RuntimeConnection({
        arch: "x64",
        clientVersion: "0.0.1",
        computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
        displayName: "workstation",
        instanceId,
        platform: "linux",
        machineToken: "machine-token",
      });
      await active.run();
    }

    expect(registeredInstanceIds).toEqual(instanceIds);
  });

  it("does not create a WebSocket when stopped before startup", async () => {
    const webSocketFactory = vi.fn((_url: string) => {
      throw new Error("WebSocket must not be created after stop");
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: {
        version: 2,
        computerId: randomUUID(),
        serverUrl: "http://127.0.0.1:3000",
      },
      displayName: "workstation",
      instanceId: randomUUID(),
      machineToken: "machine-token",
      platform: "linux",
      webSocketFactory,
    });

    connection.stop();
    await connection.run();

    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("keeps heartbeats single-flight when a result is slower than the interval", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let heartbeatCount = 0;
    let releaseFirstHeartbeat: ((sendResult: () => void) => void) | undefined;
    let finishSecondHeartbeat: (() => void) | undefined;
    const firstHeartbeat = new Promise<() => void>((resolve) => {
      releaseFirstHeartbeat = resolve;
    });
    const secondHeartbeat = new Promise<void>((resolve) => {
      finishSecondHeartbeat = resolve;
    });
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(10, 500));
        } else if (frame.type === "computer:register") {
          completeRegistration(socket, frame);
        } else if (frame.type === "heartbeat") {
          heartbeatCount += 1;
          const sendResult = () => completeHeartbeat(socket, frame);
          if (heartbeatCount === 1) releaseFirstHeartbeat?.(sendResult);
          else {
            connection.stop();
            finishSecondHeartbeat?.();
          }
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });

    const running = connection.run();
    const sendFirstResult = await firstHeartbeat;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(heartbeatCount).toBe(1);
    sendFirstResult();
    await secondHeartbeat;
    await running;
    expect(heartbeatCount).toBe(2);
  });

  it("fails closed on an unmatched heartbeat result", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          completeAuth(socket, frame, welcome(10, 500));
        } else if (frame.type === "computer:register") {
          completeRegistration(socket, frame);
        } else if (frame.type === "heartbeat") {
          socket.send(
            JSON.stringify({
              type: "heartbeat:result",
              requestId: randomUUID(),
              ok: true,
              serverTime: new Date().toISOString(),
              protocolVersion: RUNTIME_PROTOCOL_V2,
              connectionId: frame.connectionId,
            }),
          );
        }
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });

    await expect(connection.run()).rejects.toThrow("unmatched heartbeat result");
  });

  it("falls back once only after an explicit matching v2 rejection", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const authVersions: unknown[] = [];
    let connection: RuntimeConnection;
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") {
          authVersions.push(frame.protocolVersion);
          if (frame.protocolVersion === RUNTIME_PROTOCOL_V2) {
            socket.send(
              JSON.stringify({
                type: "error",
                requestId: frame.requestId,
                code: "PROTOCOL_VERSION_UNSUPPORTED",
                message: "v2 is not supported",
              }),
            );
            socket.close(4400, "Protocol version unsupported");
          } else {
            completeAuth(socket, frame, welcome(1_000, 2_000, RUNTIME_PROTOCOL_V1));
          }
        } else if (frame.type === "computer:register") {
          completeRegistration(socket, frame);
          connection.stop();
        }
      });
    });
    connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.2",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });

    await connection.run();
    expect(authVersions).toEqual([RUNTIME_PROTOCOL_V2, RUNTIME_PROTOCOL_V1]);
  });

  it("does not downgrade for an unmatched version rejection", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let connections = 0;
    server.wss.on("connection", (socket) => {
      connections += 1;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type !== "auth") return;
        socket.send(
          JSON.stringify({
            type: "error",
            requestId: randomUUID(),
            code: "PROTOCOL_VERSION_UNSUPPORTED",
            message: "unmatched downgrade attempt",
          }),
        );
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.2",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });

    await expect(connection.run()).rejects.toThrow("unmatched downgrade attempt");
    expect(connections).toBe(1);
  });

  it("fails closed on a protocol mismatch", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type !== "auth") return;
        socket.send(
          JSON.stringify({
            type: "auth:result",
            requestId: frame.requestId,
            ok: true,
            computerId: randomUUID(),
            installationId: randomUUID(),
          }),
        );
        socket.send(JSON.stringify({ ...welcome(), protocolVersion: 3 }));
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });
    await expect(connection.run()).rejects.toThrow("protocol version is unsupported");
  });

  it("fails closed when the Server changes the negotiated capability map", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") completeAuth(socket, frame);
        else if (frame.type === "computer:register") {
          const result = registrationResult(frame);
          socket.send(
            JSON.stringify({
              ...result,
              negotiatedCapabilities: { "runtime.imDelivery": 1 },
            }),
          );
        }
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.2",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });

    await expect(connection.run()).rejects.toThrow("invalid capability negotiation");
  });

  it("publishes registered state, dispatches business frames in isolation, and sends through the active socket", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    let receiveBusinessResult: ((frame: Record<string, unknown>) => void) | undefined;
    const businessResult = new Promise<Record<string, unknown>>((resolve) => {
      receiveBusinessResult = resolve;
    });
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "auth") completeAuth(socket, frame, welcome(1_000, 2_000));
        else if (frame.type === "computer:register") {
          const result = registrationResult(frame);
          socket.send(JSON.stringify(result));
          setImmediate(() =>
            socket.send(JSON.stringify({ type: "test:event", value: 1, connectionId: result.connectionId })),
          );
        } else if (frame.type === "test:result") receiveBusinessResult?.(frame);
      });
    });
    const logs: RecordedLog[] = [];
    const received: Record<string, unknown>[] = [];
    const states: string[] = [];
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      logger: recordingLogger(logs),
      parseBusinessFrame: (value) => {
        if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== "test:event") {
          return undefined;
        }
        return value as { type: string; value: number };
      },
      platform: "linux",
      machineToken: "machine-token",
    });
    connection.subscribeState((state) => states.push(state));
    connection.subscribeBusinessFrames(() => {
      throw new RuntimeStorageError("conflict", "secret-bearing listener failure");
    });
    connection.subscribeBusinessFrames((frame) => {
      received.push(frame);
    });

    const registered = connection.whenRegistered();
    const running = connection.run();
    await registered;
    await vi.waitFor(() => expect(received).toEqual([{ type: "test:event", value: 1 }]));
    await connection.send({ type: "test:result", ok: true }, { priority: "result" });
    await expect(businessResult).resolves.toMatchObject({
      type: "test:result",
      ok: true,
      connectionId: expect.any(String),
    });
    await vi.waitFor(() =>
      expect(logs).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({
            category: "listener",
            errorCategory: "runtime_storage_conflict",
            frameType: "test:event",
          }),
          level: "warn",
          message: "Runtime business frame listener failed",
        }),
      ),
    );
    expect(JSON.stringify(logs)).not.toContain("secret-bearing listener failure");
    connection.stop();
    await running;

    expect(states).toEqual([
      "stopped",
      "connecting",
      "authenticating",
      "welcoming",
      "registering",
      "registered",
      "stopped",
    ]);
  });

  it("rejects binary server frames before decoding them as JSON", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(Buffer.from(JSON.stringify({ type: "auth:result" })), { binary: true });
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });

    await expect(connection.run()).rejects.toThrow("binary runtime frame");
  });

  it("rejects oversized outbound frames without writing them to the socket", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    const receivedTypes: unknown[] = [];
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        receivedTypes.push(frame.type);
        if (frame.type === "auth") completeAuth(socket, frame, welcome(1_000, 2_000));
        else if (frame.type === "computer:register") {
          completeRegistration(socket, frame);
        }
      });
    });
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      platform: "linux",
      machineToken: "machine-token",
    });
    const running = connection.run();
    await connection.whenRegistered();

    await expect(connection.send({ type: "test:large", text: "你".repeat(64 * 1024) })).rejects.toMatchObject({
      code: "frame_too_large",
    });
    expect(receivedTypes).toEqual(["auth", "computer:register"]);
    connection.stop();
    await running;
  });

  it("aborts an injected retry wait when stopped", async () => {
    const server = await runtimeServer();
    cleanup.push(server.close);
    server.wss.on("connection", (socket) => socket.terminate());
    let retrySignal: AbortSignal | undefined;
    const connection = new RuntimeConnection({
      arch: "x64",
      clientVersion: "0.0.1",
      computer: { version: 2, computerId: randomUUID(), serverUrl: server.url },
      displayName: "workstation",
      instanceId: randomUUID(),
      jitter: () => 0,
      platform: "linux",
      machineToken: "machine-token",
      waitForRetry: async (_milliseconds, signal) => {
        retrySignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    const running = connection.run();
    await vi.waitFor(() => expect(retrySignal).toBeDefined());
    connection.stop();
    await running;
    expect(retrySignal?.aborted).toBe(true);
  });

  it("drains queued results and reports before trace frames", async () => {
    const socket = new ControlledWebSocket();
    const connection = controlledConnection(socket, { trace: 3 });
    const running = connection.run();
    await registerControlled(connection, socket);
    socket.autoFlush = false;

    const firstTrace = connection.send({ type: "test:trace", sequence: 1 }, { priority: "trace" });
    const secondTrace = connection.send({ type: "test:trace", sequence: 2 }, { priority: "trace" });
    const report = connection.send({ type: "test:report" }, { priority: "report" });
    const result = connection.send({ type: "test:result" }, { priority: "result" });
    expect(socket.businessTypes()).toEqual(["test:trace"]);

    socket.releaseNextSend();
    expect(socket.businessTypes()).toEqual(["test:trace", "test:result"]);
    socket.releaseNextSend();
    expect(socket.businessTypes()).toEqual(["test:trace", "test:result", "test:report"]);
    socket.releaseNextSend();
    expect(socket.businessTypes()).toEqual(["test:trace", "test:result", "test:report", "test:trace"]);
    socket.releaseNextSend();
    await Promise.all([firstTrace, secondTrace, report, result]);

    connection.stop();
    await running;
  });

  it("drops trace queue overflow without terminating the registered socket", async () => {
    const socket = new ControlledWebSocket();
    const connection = controlledConnection(socket, { trace: 1 });
    const running = connection.run();
    await registerControlled(connection, socket);
    socket.autoFlush = false;

    const accepted = connection.send({ type: "test:trace", sequence: 1 }, { priority: "trace" });
    await expect(connection.send({ type: "test:trace", sequence: 2 }, { priority: "trace" })).rejects.toMatchObject({
      code: "overflow",
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.releaseNextSend();
    await accepted;

    connection.stop();
    await running;
  });
});

function welcome(
  heartbeatIntervalMs = 10,
  heartbeatTimeoutMs = 1_000,
  protocolVersion: typeof RUNTIME_PROTOCOL_V1 | typeof RUNTIME_PROTOCOL_V2 = RUNTIME_PROTOCOL_V2,
) {
  if (protocolVersion === RUNTIME_PROTOCOL_V1) {
    return {
      type: "server:welcome",
      protocolVersion: RUNTIME_PROTOCOL_V1,
      capabilities: { sessionReconcile: 1, imDelivery: 1, turnReport: 1, agentTrace: 1, imCredentialGrant: 1 },
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
    } as const;
  }
  return {
    type: "server:welcome",
    protocolVersion: RUNTIME_PROTOCOL_V2,
    supportedProtocolVersions: RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
    supportedCapabilities: RUNTIME_SERVER_CAPABILITY_OFFERS,
    requiredClientCapabilities: [],
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
  } as const;
}

function completeAuth(
  socket: WebSocket,
  frame: Record<string, unknown>,
  serverWelcome?: Record<string, unknown>,
): void {
  socket.send(
    JSON.stringify({
      type: "auth:result",
      requestId: frame.requestId,
      ok: true,
      computerId: randomUUID(),
      installationId: randomUUID(),
    }),
  );
  socket.send(
    JSON.stringify(
      serverWelcome ??
        welcome(10, 1_000, frame.protocolVersion === RUNTIME_PROTOCOL_V1 ? RUNTIME_PROTOCOL_V1 : RUNTIME_PROTOCOL_V2),
    ),
  );
}

function registrationResult(frame: Record<string, unknown>): Record<string, unknown> {
  if (frame.protocolVersion !== RUNTIME_PROTOCOL_V2) {
    return { type: "computer:register:result", requestId: frame.requestId, ok: true };
  }
  return {
    type: "computer:register:result",
    requestId: frame.requestId,
    ok: true,
    protocolVersion: RUNTIME_PROTOCOL_V2,
    connectionId: randomUUID(),
    negotiatedCapabilities: negotiateRuntimeCapabilities(
      RUNTIME_CLIENT_CAPABILITY_OFFERS,
      RUNTIME_SERVER_CAPABILITY_OFFERS,
    ),
  };
}

function completeRegistration(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(registrationResult(frame)));
}

function completeHeartbeat(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(
    JSON.stringify({
      type: "heartbeat:result",
      requestId: frame.requestId,
      ok: true,
      serverTime: new Date().toISOString(),
      ...(frame.protocolVersion === RUNTIME_PROTOCOL_V2
        ? { protocolVersion: RUNTIME_PROTOCOL_V2, connectionId: frame.connectionId }
        : {}),
    }),
  );
}

async function runtimeServer(): Promise<{ close(): Promise<void>; url: string; wss: WebSocketServer }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    wss,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function controlledOptions(socket: ControlledWebSocket): ConstructorParameters<typeof RuntimeConnection>[0] {
  return {
    arch: "x64",
    clientVersion: "0.0.1",
    computer: {
      version: 2,
      computerId: randomUUID(),
      serverUrl: "http://127.0.0.1:8000",
    },
    displayName: "workstation",
    instanceId: randomUUID(),
    platform: "linux",
    queueLimits: { trace: 2 },
    machineToken: "machine-token",
    webSocketFactory: () => socket as unknown as WebSocket,
  };
}

function controlledConnection(socket: ControlledWebSocket, queueLimits: { trace: number }): RuntimeConnection {
  return new RuntimeConnection({ ...controlledOptions(socket), queueLimits });
}

class ManualScheduler {
  readonly #now: () => number;
  readonly #timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
  #nextId = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
    const timer = this.#nextId++ as unknown as ReturnType<typeof setTimeout>;
    this.#timers.set(timer, { at: this.#now() + milliseconds, callback });
    return timer;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.#timers.delete(timer);
  }

  runDue(): void {
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= this.#now())
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) return;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
  }
}

async function registerControlled(
  connection: RuntimeConnection,
  socket: ControlledWebSocket,
  serverWelcome: ReturnType<typeof welcome> = welcome(1_000, 2_000),
): Promise<string> {
  await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
  socket.open();
  await vi.waitFor(() => expect(socket.frame("auth")).toBeDefined());
  const auth = socket.frame("auth");
  socket.receive({
    type: "auth:result",
    requestId: auth?.requestId,
    ok: true,
    computerId: randomUUID(),
    installationId: randomUUID(),
  });
  socket.receive(serverWelcome);
  await vi.waitFor(() => expect(socket.frame("computer:register")).toBeDefined());
  const register = socket.frame("computer:register");
  const result = registrationResult(register ?? {});
  socket.receive(result);
  await connection.whenRegistered();
  return String(result.connectionId);
}

class ControlledWebSocket extends EventEmitter {
  autoFlush = true;
  readyState: number = WebSocket.CONNECTING;
  readonly #frames: Array<Record<string, unknown>> = [];
  readonly #sendCallbacks: Array<(error?: Error) => void> = [];

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.#frames.push(JSON.parse(data) as Record<string, unknown>);
    if (!callback) return;
    if (this.autoFlush) callback();
    else this.#sendCallbacks.push(callback);
  }

  receive(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  receiveData(data: string | Buffer | ArrayBuffer | readonly Buffer[], isBinary = false): void {
    this.emit("message", data, isBinary);
  }

  frame(type: string): Record<string, unknown> | undefined {
    return this.#frames.find((frame) => frame.type === type);
  }

  businessTypes(): unknown[] {
    return this.#frames
      .filter((frame) => typeof frame.type === "string" && String(frame.type).startsWith("test:"))
      .map((frame) => frame.type);
  }

  releaseNextSend(): void {
    const callback = this.#sendCallbacks.shift();
    if (!callback) throw new Error("No controlled WebSocket send is pending");
    callback();
  }

  close(code = 1000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close", code));
  }

  terminate(): void {
    this.close(1006);
  }
}
