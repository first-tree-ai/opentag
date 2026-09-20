import { randomUUID } from "node:crypto";
import { CLOUD_CAPABILITY_HEADER } from "./cloud-identities-data.mjs";

export function cloudIdentityHeaders() {
  return { [CLOUD_CAPABILITY_HEADER]: "1" };
}

export function readinessV2Headers() {
  return { "x-opentag-provider-readiness": "1", "x-opentag-provider-readiness-v2": "2" };
}

function headerBag(baseUrl, cookies, method, body, headers, csrf) {
  const values = { origin: baseUrl, ...headers };
  const cookie = cookies?.header?.() ?? "";
  if (cookie) values.cookie = cookie;
  const token = csrf ? cookies?.get?.("opentag_csrf") : undefined;
  if (token && method !== "GET" && method !== "HEAD") values["x-opentag-csrf"] = token;
  if (body !== undefined) values["content-type"] = "application/json";
  return values;
}

async function parseBody(response, cookies) {
  if (cookies && typeof response.headers.getSetCookie === "function") {
    cookies.store(response.headers.getSetCookie());
  }
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function requestJson({
  baseUrl,
  cookies,
  method,
  path,
  body,
  headers,
  csrf = true,
  timeoutMs = 30_000,
  signal,
}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: headerBag(baseUrl, cookies, method, body, headers, csrf),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ok: response.ok, body: await parseBody(response, cookies) };
}

export function refusalShape({ status, body }) {
  const error = body?.error ?? {};
  return {
    status,
    code: error.code,
    message: String(error.message ?? ""),
  };
}

export async function concurrentPost(options, body) {
  return Promise.all([
    requestJson({ method: "POST", ...options, body }),
    requestJson({ method: "POST", ...options, body }),
  ]);
}

function waitSocket(socket, eventName, predicate, timeoutMs = 10_000) {
  return new Promise((resolveWait, rejectWait) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener(eventName, onEvent);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const finish = (error, value) => {
      cleanup();
      if (error) rejectWait(error);
      else resolveWait(value);
    };
    const onClose = () => finish(new Error(`Runtime WebSocket closed while waiting for ${eventName}`));
    const onError = () => finish(new Error(`Runtime WebSocket failed while waiting for ${eventName}`));
    const onEvent = (event) => {
      if (eventName === "open") return finish(undefined, undefined);
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "error")
        return finish(Object.assign(new Error(`Runtime frame rejected: ${frame.code}`), { code: frame.code }));
      if (predicate(frame)) finish(undefined, frame);
    };
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for runtime ${eventName}`)), timeoutMs);
    socket.addEventListener(eventName, onEvent);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

async function exchangeFrame(socket, frame, responseType) {
  const response = waitSocket(
    socket,
    "message",
    (value) => value.type === responseType && value.requestId === frame.requestId,
  );
  socket.send(JSON.stringify(frame));
  return response;
}

async function authenticateSocket(socket, machineToken, shared) {
  await waitSocket(socket, "open");
  return exchangeFrame(
    socket,
    {
      type: "auth",
      requestId: randomUUID(),
      protocolVersion: shared.RUNTIME_PROTOCOL_VERSION,
      supportedProtocolVersions: shared.RUNTIME_SUPPORTED_PROTOCOL_VERSIONS,
      machineToken,
    },
    "auth:result",
  );
}

export async function registerComputerWs({
  shared,
  wsUrl,
  machineToken,
  installationId,
  displayName = "E2 Local",
  platform = "linux",
  arch = "x64",
  clientVersion,
}) {
  const socket = new WebSocket(wsUrl);
  try {
    const auth = await authenticateSocket(socket, machineToken, shared);
    if (!auth.ok) throw new Error(auth.errorCode ?? "Runtime authentication rejected");
    const instanceId = randomUUID();
    const registered = await exchangeFrame(
      socket,
      {
        type: "computer:register",
        protocolVersion: shared.RUNTIME_PROTOCOL_VERSION,
        supportedCapabilities: shared.RUNTIME_CLIENT_CAPABILITY_OFFERS,
        requiredServerCapabilities: shared.RUNTIME_REQUIRED_SERVER_CAPABILITIES,
        requestId: randomUUID(),
        installationId,
        instanceId,
        displayName,
        platform,
        arch,
        clientVersion,
      },
      "computer:register:result",
    );
    if (!registered.ok) throw new Error(registered.errorCode ?? "Runtime registration rejected");
    const heartbeat = await exchangeFrame(
      socket,
      {
        type: "heartbeat",
        protocolVersion: shared.RUNTIME_PROTOCOL_VERSION,
        connectionId: registered.connectionId,
        requestId: randomUUID(),
        installationId,
        instanceId,
      },
      "heartbeat:result",
    );
    if (!heartbeat.ok) throw new Error(heartbeat.errorCode ?? "Runtime heartbeat rejected");
    return { socket, computerId: auth.computerId, installationId: auth.installationId, instanceId };
  } catch (error) {
    socket.close();
    throw error;
  }
}

export async function authComputerWs({ wsUrl, machineToken, shared }) {
  const socket = new WebSocket(wsUrl);
  try {
    return await authenticateSocket(socket, machineToken, shared);
  } catch (error) {
    // Invalid credentials use the protocol's error frame before closing the socket.
    if (error.code === "AUTH_INVALID_TOKEN") return { ok: false, errorCode: error.code, frameType: "error" };
    throw error;
  } finally {
    socket.close();
  }
}

export function record(assertions, name, ok, detail = "") {
  assertions.push({ name, ok: Boolean(ok), detail: String(detail ?? "") });
  if (!ok) throw new Error(`assertion ${name} failed${detail ? `: ${detail}` : ""}`);
}
