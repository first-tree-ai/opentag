import { WEB_FETCH_TIMEOUT_CAP_MS, WEB_SEARCH_TIMEOUT_CAP_MS } from "@opentag/shared";

/**
 * In-Sandbox web bridge source (trusted, self-contained, Node builtins only).
 *
 * The parent Runner runs this exact source through the verified dedicated `sandbox exec`
 * stdin/stdout duplex channel: `node -e <source> <socketPath>`. The bridge opens a fresh private
 * Unix listener inside its own Sandbox namespace, accepts only the two fixed HTTP paths
 * (`/web/search`, `/web/fetch`), enforces the strict capped ingress budget across the body read,
 * and forwards only the remaining budget over the pipe. No network listener, credential, or
 * tenant identity ever exists inside the Sandbox; the parent reconstructs authority and
 * validates every frame again.
 *
 * Frames are 4-byte big-endian length + UTF-8 JSON. The bridge removes only the socket it
 * created (dev/ino proof) and exits when the parent closes the pipe or the process is killed.
 */
export const WEB_BRIDGE_MAX_FRAME_BYTES = 6 * 1024 * 1024;
export const WEB_BRIDGE_MAX_REQUEST_BYTES = 16 * 1024;

/** Strict hop-budget grammar shared with the parent gateway: 1..7 ASCII digits, positive. */
export const WEB_BRIDGE_BUDGET_PATTERN = /^[0-9]{1,7}$/;

export const WEB_BRIDGE_SOURCE = `
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const socketPath = process.argv[1];
if (typeof socketPath !== "string" || socketPath[0] !== "/" || socketPath.includes("\\n")) {
  process.stderr.write("web bridge socket path is required\\n");
  process.exit(2);
}
const MAX_FRAME = 6291456;
const MAX_REQUEST = 16384;
const SEARCH_CAP = ${WEB_SEARCH_TIMEOUT_CAP_MS};
const FETCH_CAP = ${WEB_FETCH_TIMEOUT_CAP_MS};
const BUDGET_PATTERN = /^[0-9]{1,7}$/;
let socketIdentity;
try {
  socketIdentity = fs.statSync(socketPath);
} catch (error) {
  if (error.code !== "ENOENT") {
    process.stderr.write("web bridge socket path is unreadable\\n");
    process.exit(2);
  }
}
if (socketIdentity) {
  process.stderr.write("web bridge socket path is occupied\\n");
  process.exit(2);
}
let input = Buffer.alloc(0);
let nextId = 1;
let closing = false;
const pending = new Map();
const writeFrame = (value) => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  process.stdout.write(frame);
};
const sendLocal = (response, status, code, message, retryable) => {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(
    JSON.stringify({ error: { code, message, ...(retryable === undefined ? {} : { retryable }) } }),
  );
};
const shutdown = (code) => {
  if (closing) return;
  closing = true;
  try {
    server.close(() => {});
  } catch (error) {
    /* Listener already closed. */
  }
  for (const entry of pending.values()) {
    try {
      entry.response.destroy();
    } catch (error) {
      /* Response already gone. */
    }
  }
  pending.clear();
  try {
    const current = fs.lstatSync(socketPath);
    if (
      socketIdentity &&
      current.isSocket() &&
      current.dev === socketIdentity.dev &&
      current.ino === socketIdentity.ino
    ) {
      fs.unlinkSync(socketPath);
    }
  } catch (error) {
    /* The socket is already gone or belongs to a successor. */
  }
  process.exit(code);
};
const handleFrame = (frame) => {
  if (!frame || typeof frame !== "object") return;
  if (frame.t === "response" && Number.isSafeInteger(frame.id)) {
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (entry.response.writableEnded || entry.response.destroyed) return;
    entry.response.writeHead(
      Number.isSafeInteger(frame.status) ? frame.status : 500,
      { "content-type": "application/json", "cache-control": "no-store" },
    );
    entry.response.end(typeof frame.body === "string" ? frame.body : "");
    return;
  }
  if (frame.t === "cancel" && Number.isSafeInteger(frame.id)) {
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    entry.response.destroy();
  }
};
/**
 * One request under the strict monotonic ingress budget. The deadline starts before the body is
 * read; an unfinished body yields a bounded 504 instead of hanging until the parent safety
 * timeout, and the forwarded frame carries only the budget that is actually left.
 */
const onRequest = (request, response) => {
  const pathName = request.url;
  const operation = pathName === "/web/search" ? "search" : pathName === "/web/fetch" ? "fetch" : undefined;
  if (!operation) {
    sendLocal(response, 404, "invalid_request", "Unknown web gateway operation");
    request.resume();
    return;
  }
  const cap = operation === "search" ? SEARCH_CAP : FETCH_CAP;
  const rawRemaining = request.headers["x-web-remaining-ms"];
  let budget = cap;
  if (rawRemaining !== undefined) {
    const value = Array.isArray(rawRemaining) ? rawRemaining[0] : rawRemaining;
    if (typeof value !== "string" || !BUDGET_PATTERN.test(value) || Number(value) < 1) {
      sendLocal(response, 400, "invalid_request", "The web bridge request budget is invalid");
      request.resume();
      return;
    }
    budget = Math.min(Number(value), cap);
  }
  const deadlineAt = Date.now() + budget;
  const chunks = [];
  let total = 0;
  let settled = false;
  const settle = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(() => {
    settle(() => {
      sendLocal(response, 504, "timeout", "The web request budget was exhausted", true);
      request.pause();
    });
  }, budget);
  timer.unref?.();
  request.on("data", (chunk) => {
    if (settled) return;
    total += chunk.length;
    if (total > MAX_REQUEST) {
      settle(() => {
        sendLocal(response, 413, "invalid_request", "The web bridge request exceeds the bound");
        request.pause();
      });
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    settle(() => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        sendLocal(response, 504, "timeout", "The web request budget was exhausted", true);
        return;
      }
      const id = nextId++;
      pending.set(id, { response });
      response.on("close", () => {
        if (!response.writableFinished && pending.delete(id)) writeFrame({ t: "cancel", id });
      });
      writeFrame({
        t: "request",
        id,
        path: pathName,
        body: Buffer.concat(chunks).toString("base64"),
        remaining: String(remaining),
      });
    });
  });
  request.on("aborted", () => settle(() => {}));
  request.on("error", () => settle(() => {}));
};
const server = http.createServer((request, response) => {
  if (request.method !== "POST") {
    sendLocal(response, 404, "invalid_request", "Unknown web bridge operation");
    request.resume();
    return;
  }
  onRequest(request, response);
});
server.on("error", (error) => {
  process.stderr.write("web bridge listener failed: " + (error && error.code ? error.code : "error") + "\\n");
  process.exit(2);
});
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    if (input.length < 4) return;
    const size = input.readUInt32BE(0);
    if (size > MAX_FRAME) {
      process.stderr.write("web bridge frame exceeds the bound\\n");
      shutdown(3);
      return;
    }
    if (input.length < 4 + size) return;
    const payload = input.subarray(4, 4 + size);
    input = input.subarray(4 + size);
    try {
      handleFrame(JSON.parse(payload.toString("utf8")));
    } catch (error) {
      shutdown(3);
      return;
    }
  }
});
process.stdin.on("end", () => shutdown(0));
process.stdin.resume();
server.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    /* Best-effort permission tightening inside the Sandbox namespace. */
  }
  socketIdentity = fs.statSync(socketPath);
  writeFrame({ t: "ready" });
});
`;
