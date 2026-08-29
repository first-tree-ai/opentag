#!/usr/bin/env node

import { createServer } from "node:http";

const mode = process.argv[2];
const port = Number.parseInt(process.argv[3] ?? "8080", 10);
const secretBody = "doctor-e2e-response-secret";

if (!mode || !Number.isInteger(port)) {
  throw new Error("usage: fault-server.mjs <healthy|baseline|http-503|invalid-schema|hang> [port]");
}

let requestCount = 0;
const sockets = new Set();
const server = createServer((request, response) => {
  if (request.url === "/__count") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ count: requestCount }));
    return;
  }

  requestCount += 1;
  if (request.url !== "/healthz") {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  if (mode === "hang") return;
  if (mode === "http-503") {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(secretBody);
    return;
  }
  if (mode === "invalid-schema") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: secretBody }));
    return;
  }
  if (mode === "healthy" || mode === "baseline") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "opentag-server" }));
    return;
  }
  response.writeHead(500);
  response.end("unknown fault mode");
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

server.on("upgrade", (_request, socket) => {
  requestCount += 1;
  if (mode !== "baseline") socket.destroy();
  // Baseline mode intentionally leaves the real TCP connection open without completing
  // the WebSocket handshake. The daemon remains alive, but doctor still checks only /healthz.
});

const stop = () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`doctor fault server ${mode} listening on ${port}\n`);
});
