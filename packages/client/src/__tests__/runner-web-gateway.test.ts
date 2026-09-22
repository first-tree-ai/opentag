import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSandboxRunArgv,
  NativeSandbox,
  SANDBOX_BINARY,
  SANDBOX_NODE,
  type SpawnProcess,
} from "../runner/native-sandbox.js";
import { NativeSandboxWebGateway, type NativeWebExecutionAuthority } from "../runner/web-gateway.js";
import { WebGatewayDispatchError } from "../runtime/web-tools-gateway.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/**
 * A Sandbox whose exec argv is executed by the local Node runtime. `buildSandboxExecArgv`
 * produces `<binary> exec <name> -- <command> <args...>`, so the stub runs everything after the
 * `--` verbatim under the test Node. This exercises the real duplex pipe and the real bridge
 * source without a Cloud Sandbox.
 */
function localSandbox(name = "ots-web-test", onSpawn?: () => void): NativeSandbox {
  const spawnProcess: SpawnProcess = (_command, args) => {
    const separator = args.indexOf("--");
    const [binary, ...rest] = args.slice(separator + 1);
    if (binary !== SANDBOX_NODE) throw new Error(`unexpected sandbox command ${binary ?? "<missing>"}`);
    onSpawn?.();
    return spawn(process.execPath, rest, { stdio: "pipe" });
  };
  return new NativeSandbox({ name, workspace: join(tmpdir(), `opentag-web-ws-${name}`), spawnProcess });
}

function httpCall(
  socketPath: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

const searchResult = (requestId: string) => ({
  requestId,
  status: "ok" as const,
  retrievedAt: "2026-09-17T00:00:00.000Z",
  effectiveDepth: "basic" as const,
  results: [],
});

/**
 * Controlled unfinished body: headers plus a partial payload, never ended. Resolves on the
 * response (or reports the caller's own safety timeout so a hang fails the test loudly).
 */
function stalledCall(
  socketPath: string,
  remainingHeader: string,
  safetyMs = 1_500,
): Promise<{ status: number; body: string; safety: boolean }> {
  const payload = JSON.stringify({ protocolVersion: 1, toolCallId: randomUUID(), query: "stalled" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { status: number; body: string; safety: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = http.request(
      {
        socketPath,
        path: "/web/search",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload) + 50),
          "x-web-remaining-ms": remainingHeader,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          finish({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), safety: false }),
        );
        response.on("error", () => finish({ status: 0, body: "response_error", safety: false }));
      },
    );
    request.on("error", (error) => finish({ status: 0, body: error.message, safety: false }));
    const timer = setTimeout(() => {
      finish({ status: 0, body: "safety_timeout", safety: true });
      request.destroy();
    }, safetyMs);
    request.flushHeaders();
    request.write(payload.slice(0, 10));
  });
}

/** One macrotask boundary: enough for the channel's constructor wiring to complete. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function authority(
  executionIdentity: string,
  options: { signal?: AbortSignal; dispatch?: NativeWebExecutionAuthority["dispatch"] } = {},
): NativeWebExecutionAuthority {
  return {
    executionIdentity,
    ...(options.signal ? { signal: options.signal } : {}),
    dispatch:
      options.dispatch ??
      (async (input) =>
        input.operation === "search"
          ? searchResult("bridge-search")
          : { ...searchResult("bridge-fetch"), results: [] }),
  };
}

/**
 * A fully in-process `NativeSandbox` double for the bridge CHANNEL itself: it hands the channel a
 * scripted duplex so frame decoding, readiness, cancellation, and teardown can be driven exactly.
 */
function duplexSandbox(input: { name?: string; onOpen?: (duplex: FakeDuplex) => void }): {
  sandbox: NativeSandbox;
  duplex: () => FakeDuplex;
} {
  let created: FakeDuplex | undefined;
  const sandbox = {
    name: input.name ?? "ots-web-test",
    openDuplex: () => {
      created = new FakeDuplex();
      input.onOpen?.(created);
      return created;
    },
  } as unknown as NativeSandbox;
  return {
    duplex: () => {
      if (!created) throw new Error("the duplex was never opened");
      return created;
    },
    sandbox,
  };
}

/** A duplex whose listeners the test drives directly, mirroring the real pipe contract. */
class FakeDuplex {
  asStream(): never {
    throw new Error("Web gateway uses the callback pipe interface");
  }
  readonly written: Buffer[] = [];
  readonly kills: (NodeJS.Signals | undefined)[] = [];
  ended = false;
  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly stderrListeners = new Set<(chunk: Buffer) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  write(chunk: Uint8Array): void {
    const buffer = Buffer.from(chunk);
    this.written.push(buffer);
    for (const frame of this.decoded()) void frame;
  }

  end(): void {
    this.ended = true;
    this.emitExit(0, null);
  }

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal);
  }

  onData(listener: (chunk: Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onStderr(listener: (chunk: Buffer) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Deliver one decoded frame the way the real bridge process would. */
  send(frame: unknown): void {
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    for (const listener of [...this.dataListeners]) listener(Buffer.concat([header, body]));
  }

  /** Deliver raw bytes, for malformed-frame coverage. */
  sendRaw(chunk: Buffer): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  emitStderr(chunk: Buffer): void {
    for (const listener of [...this.stderrListeners]) listener(chunk);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  /** The frames this channel wrote back, decoded. */
  decoded(): unknown[] {
    const frames: unknown[] = [];
    for (const buffer of this.written) {
      const size = buffer.readUInt32BE(0);
      frames.push(JSON.parse(buffer.subarray(4, 4 + size).toString("utf8")));
    }
    return frames;
  }
}

describe("NativeSandboxWebGateway", () => {
  it("relays a strict request and response over the dedicated sandbox exec pipe", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const seen: Array<{ toolCallId: string; remainingMs: number; query: string }> = [];
    const channel = await gateway.openExecution({
      sandbox: localSandbox(),
      authority: authority("exec-one", {
        dispatch: async (input) => {
          if (input.operation !== "search") throw new Error("unexpected operation");
          seen.push({ toolCallId: input.toolCallId, remainingMs: input.remainingMs, query: input.params.query });
          return searchResult("pipe-response");
        },
      }),
      startupTimeoutMs: 10_000,
    });
    expect(channel.socketPath.startsWith("/tmp/opentag-web-")).toBe(true);
    const toolCallId = randomUUID();
    const response = await httpCall(
      channel.socketPath,
      "/web/search",
      { protocolVersion: 1, toolCallId, query: "over the pipe" },
      { "x-web-remaining-ms": "9000" },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).requestId).toBe("pipe-response");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolCallId).toBe(toolCallId);
    expect(seen[0]?.query).toBe("over the pipe");
    expect(seen[0]?.remainingMs).toBeGreaterThan(0);
    expect(seen[0]?.remainingMs).toBeLessThanOrEqual(9_000);
    // The bridge removes its own listener on graceful close; no parent cleanup touches it.
    await gateway.close();
    await expect(lstat(channel.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives every execution its own fresh endpoint and never retargets an authority", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const sandbox = localSandbox();
    const first = await gateway.openExecution({ sandbox, authority: authority("exec-one") });
    const firstPath = first.socketPath;
    await expect(gateway.openExecution({ sandbox, authority: authority("exec-two") })).rejects.toThrow(
      /already has an active execution channel/,
    );
    await first.close();
    const second = await gateway.openExecution({ sandbox, authority: authority("exec-two") });
    expect(second.socketPath).not.toBe(firstPath);
    // The predecessor descriptor is gone, so an old process cannot reach the successor.
    await expect(lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    const response = await httpCall(second.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    });
    expect(response.status).toBe(200);
    await second.close();
  });

  it("serves a successor on the same gateway after the predecessor is revoked", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const sandbox = localSandbox();
    const revoke = new AbortController();
    const first = await gateway.openExecution({
      sandbox,
      authority: authority("exec-revoked", { signal: revoke.signal }),
    });
    revoke.abort();
    await first.whenClosed;
    const second = await gateway.openExecution({ sandbox, authority: authority("exec-successor") });
    expect(second.socketPath).not.toBe(first.socketPath);
    const response = await httpCall(second.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    });
    expect(response.status).toBe(200);
    // Repeated close() awaits the same in-progress teardown instead of reporting early.
    expect(second.close()).toBe(second.close());
    await second.close();
  });

  it("refuses an overlapping open before the first channel is ready and never spawns a second bridge", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const spawns: number[] = [];
    const sandbox = localSandbox("ots-web-test", () => spawns.push(1));
    const first = gateway.openExecution({ sandbox, authority: authority("exec-first") });
    await expect(gateway.openExecution({ sandbox, authority: authority("exec-second") })).rejects.toThrow(
      /active execution channel/,
    );
    const channel = await first;
    expect(spawns).toHaveLength(1);
    await channel.close();
  });

  it("repeated gateway close awaits the same in-progress teardown", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const channel = await gateway.openExecution({ sandbox: localSandbox(), authority: authority("exec-close") });
    const closing = gateway.close();
    expect(gateway.close()).toBe(closing);
    await closing;
    expect(channel.closed).toBe(true);
    await expect(lstat(channel.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails an already-revoked authority before spawning any bridge", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const spawns: number[] = [];
    const revoke = new AbortController();
    revoke.abort();
    await expect(
      gateway.openExecution({
        sandbox: localSandbox("ots-web-test", () => spawns.push(1)),
        authority: authority("exec-pre-aborted", { signal: revoke.signal }),
      }),
    ).rejects.toThrow(/already revoked/);
    expect(spawns).toHaveLength(0);
  });

  it("returns a bounded 504 for an unfinished body instead of waiting for a safety timeout", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    let dispatches = 0;
    const channel = await gateway.openExecution({
      sandbox: localSandbox(),
      authority: authority("exec-stalled", {
        dispatch: async () => {
          dispatches += 1;
          return searchResult("never");
        },
      }),
    });
    const result = await stalledCall(channel.socketPath, "100");
    expect(result.safety).toBe(false);
    expect(result.status).toBe(504);
    expect(JSON.parse(result.body).error.code).toBe("timeout");
    expect(dispatches).toBe(0);
    await channel.close();
  });

  it("enforces strict capped budget grammar at the Sandbox ingress", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const budgets: number[] = [];
    const channel = await gateway.openExecution({
      sandbox: localSandbox(),
      authority: authority("exec-budget", {
        dispatch: async (input) => {
          budgets.push(input.remainingMs);
          return searchResult("budget");
        },
      }),
    });
    const toolCallId = randomUUID();
    const body = { protocolVersion: 1, toolCallId, query: "q" };
    for (const invalid of ["0", "abc", "12345678", "-5", "+1"]) {
      const response = await httpCall(channel.socketPath, "/web/search", body, { "x-web-remaining-ms": invalid });
      expect(response.status, `header ${invalid}`).toBe(400);
    }
    const capped = await httpCall(channel.socketPath, "/web/search", body, { "x-web-remaining-ms": "9999999" });
    expect(capped.status).toBe(200);
    const explicit = await httpCall(channel.socketPath, "/web/search", body, { "x-web-remaining-ms": "25" });
    expect(explicit.status).toBe(200);
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(15_000);
    expect(budgets[1]).toBeGreaterThan(0);
    expect(budgets[1]).toBeLessThanOrEqual(25);
    // Invalid budgets never reached dispatch.
    await channel.close();
  });

  it("cancels in-flight dispatch and closes the listener when the authority is revoked", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const revoke = new AbortController();
    let dispatchEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      dispatchEntered = resolve;
    });
    let observedAbort = false;
    const channel = await gateway.openExecution({
      sandbox: localSandbox(),
      authority: authority("exec-revoke", {
        signal: revoke.signal,
        dispatch: (_input, signal) => {
          dispatchEntered();
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("revoked"));
              },
              { once: true },
            );
          });
        },
      }),
    });
    const pending = httpCall(channel.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    });
    // The revocation closes the listener under an in-flight request; keep the rejection observed.
    pending.catch(() => undefined);
    await entered;
    revoke.abort();
    await channel.whenClosed;
    await pending.catch(() => undefined);
    expect(observedAbort).toBe(true);
    await expect(lstat(channel.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves bounded dispatch error codes and rejects unknown bridge operations", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const channel = await gateway.openExecution({
      sandbox: localSandbox(),
      authority: authority("exec-errors", {
        dispatch: async () => {
          throw new WebGatewayDispatchError("request_in_progress", "still running");
        },
      }),
    });
    const conflict = await httpCall(channel.socketPath, "/web/search", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body).error.code).toBe("request_in_progress");
    const unknown = await httpCall(channel.socketPath, "/web/delete", {
      protocolVersion: 1,
      toolCallId: randomUUID(),
      query: "q",
    });
    expect(unknown.status).toBe(404);
    await channel.close();
  });

  it("refuses to open against a different Sandbox and after close", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    await expect(
      gateway.openExecution({ sandbox: localSandbox("ots-other"), authority: authority("exec-x") }),
    ).rejects.toThrow(/target this Sandbox/);
    await gateway.close();
    await expect(gateway.openExecution({ sandbox: localSandbox(), authority: authority("exec-x") })).rejects.toThrow(
      /closed/,
    );
  });
  it("fails closed on an empty execution identity", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    await expect(gateway.openExecution({ sandbox: localSandbox(), authority: authority("") })).rejects.toThrow(
      /nonempty identity/,
    );
  });

  it("closes the channel and surfaces the failure when the bridge never becomes ready", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const harness = duplexSandbox({});
    await expect(
      gateway.openExecution({
        sandbox: harness.sandbox,
        authority: authority("exec-no-ready"),
        startupTimeoutMs: 20,
      }),
    ).rejects.toThrow(/did not become ready/);
    // The failed open closed its own bridge instead of leaking a half-open channel.
    expect(harness.duplex().written).toEqual([]);
  });

  it("fails the channel when the bridge process exits before ready", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    cleanup.push(() => gateway.close());
    const harness = duplexSandbox({});
    const opening = gateway.openExecution({
      sandbox: harness.sandbox,
      authority: authority("exec-exit-early"),
      startupTimeoutMs: 5_000,
    });
    await tick();
    harness.duplex().emitExit(2, null);
    await expect(opening).rejects.toThrow(/exited/);
  });

  it("fails the channel when the bridge dies after it became ready", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    const harness = duplexSandbox({});
    const opening = gateway.openExecution({
      sandbox: harness.sandbox,
      authority: authority("exec-die-live"),
    });
    // The bridge reports ready as soon as it is spawned.
    await tick();
    harness.duplex().send({ t: "ready" });
    const channel = await opening;
    const closed = channel.whenClosed;
    harness.duplex().emitExit(9, null);
    await closed;
    expect(channel.closed).toBe(true);
    await gateway.close();
  });

  it("kills the bridge when it sends a malformed frame", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    const harness = duplexSandbox({});
    const opening = gateway.openExecution({ sandbox: harness.sandbox, authority: authority("exec-garbage") });
    await tick();
    harness.duplex().send({ t: "ready" });
    const channel = await opening;
    const closed = channel.whenClosed;
    // An oversize length prefix is a fatal framing error, never a dropped frame.
    const bogus = Buffer.alloc(4);
    bogus.writeUInt32BE(0xffffffff, 0);
    harness.duplex().sendRaw(bogus);
    await closed;
    expect(harness.duplex().kills).toContain("SIGKILL");
    await gateway.close();
  });

  it("ignores non-object, unknown, and non-integer frames from the bridge", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    const harness = duplexSandbox({});
    const opening = gateway.openExecution({ sandbox: harness.sandbox, authority: authority("exec-noise") });
    await tick();
    harness.duplex().send({ t: "ready" });
    const channel = await opening;
    // A duplicate ready, an array frame, an unknown type, and a cancel with no integer id are all
    // ignored rather than treated as protocol failures.
    harness.duplex().send({ t: "ready" });
    harness.duplex().send([1, 2, 3]);
    harness.duplex().send({ t: "unknown" });
    harness.duplex().send({ t: "cancel", id: "not-a-number" });
    await tick();
    expect(harness.duplex().kills).toEqual([]);
    expect(channel.closed).toBe(false);
    await gateway.close();
  });

  it("rejects an unknown operation and a non-base64 body with bounded responses", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    const harness = duplexSandbox({});
    const opening = gateway.openExecution({ sandbox: harness.sandbox, authority: authority("exec-bad-request") });
    await tick();
    harness.duplex().send({ t: "ready" });
    await opening;
    for (const frame of [
      { body: "", id: 1, path: "/web/nope", remaining: "1000", t: "request" },
      { body: "not base64!!", id: 2, path: "/web/search", remaining: "1000", t: "request" },
      { body: "", id: 3, path: "/web/search", remaining: "0", t: "request" },
      { body: "", id: "bad", path: "/web/search", remaining: "1000", t: "request" },
    ]) {
      harness.duplex().send(frame);
    }
    await vi.waitFor(() => expect(harness.duplex().decoded()).toHaveLength(3));
    const responses = harness.duplex().decoded() as { status: number; body: string }[];
    expect(responses.map((response) => response.status)).toEqual([404, 400, 400]);
    expect(JSON.parse(responses[0]?.body ?? "{}").error.code).toBe("invalid_request");
    await gateway.close();
  });

  it("cancels an in-flight bridge request when the bridge asks for it", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    const harness = duplexSandbox({});
    let aborted = false;
    const opening = gateway.openExecution({
      sandbox: harness.sandbox,
      authority: authority("exec-cancel-frame", {
        dispatch: (_input, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new WebGatewayDispatchError("timeout", "cancelled"));
              },
              { once: true },
            );
          }),
      }),
    });
    await tick();
    harness.duplex().send({ t: "ready" });
    await opening;
    harness.duplex().send({
      body: Buffer.from(JSON.stringify({ protocolVersion: 1, toolCallId: randomUUID(), query: "q" }), "utf8").toString(
        "base64",
      ),
      id: 7,
      path: "/web/search",
      remaining: "1000",
      t: "request",
    });
    await vi.waitFor(() => expect(harness.duplex().kills).toEqual([]));
    harness.duplex().send({ id: 7, t: "cancel" });
    await vi.waitFor(() => expect(aborted).toBe(true));
    await gateway.close();
  });

  it("logs bridge stderr and survives a throwing debug logger", async () => {
    let logged = 0;
    const gateway = await NativeSandboxWebGateway.start({
      logger: {
        debug: () => {
          logged += 1;
          throw new Error("logger exploded");
        },
        warn: () => undefined,
      },
      sandboxName: "ots-web-test",
    });
    const harness = duplexSandbox({});
    const opening = gateway.openExecution({ sandbox: harness.sandbox, authority: authority("exec-stderr") });
    await tick();
    // The first stderr write throws from inside the logger and must not break the channel.
    harness.duplex().emitStderr(Buffer.from("bridge noise\n"));
    harness.duplex().send({ t: "ready" });
    const channel = await opening;
    expect(logged).toBeGreaterThan(0);
    expect(channel.closed).toBe(false);
    await gateway.close();
  });

  it("terminates a bridge that ignores the graceful end and awaits the exit", async () => {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: "ots-web-test" });
    const harness = duplexSandbox({
      // Swallow the graceful exit: only SIGKILL resolves the exit promise.
      onOpen: (duplex) => {
        duplex.emitExit = () => undefined;
      },
    });
    const opening = gateway.openExecution({ sandbox: harness.sandbox, authority: authority("exec-stubborn") });
    await tick();
    harness.duplex().send({ t: "ready" });
    const channel = await opening;
    const closing = channel.close();
    expect(harness.duplex().ended).toBe(true);
    // The graceful end produced no exit, so the channel escalates to SIGKILL after its bounded
    // shutdown grace rather than hanging the teardown forever.
    await vi.waitFor(() => expect(harness.duplex().kills).toContain("SIGKILL"), { timeout: 5_000 });
    FakeDuplex.prototype.emitExit.call(harness.duplex(), null, "SIGKILL");
    await closing;
    expect(channel.closed).toBe(true);
    await gateway.close();
  }, 10_000);
});

describe("native sandbox argv", () => {
  it("does not mount any web socket directory into the Sandbox", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ot-web-argv-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const resolver = join(workspace, "resolv.conf");
    await writeFile(resolver, "nameserver 192.0.2.53\n");
    const argv = buildSandboxRunArgv({
      name: "ots-argv",
      workspace,
      resolverCopy: resolver,
      sandboxBinary: SANDBOX_BINARY,
    });
    // Only the workspace and the resolver copy are mounted; no web gateway directory exists.
    expect(argv.filter((argument) => argument === "--mount")).toHaveLength(2);
    expect(argv.join(" ")).not.toMatch(/opentag\/web|web\.sock/);
  });
});
