import { RUNTIME_PROVIDER_PROXY_PATH } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import type { RuntimeProviderProxyTransport } from "../runtime-credentials/data-transport.js";

export interface RuntimeProviderProxyRoutesOptions {
  transport: RuntimeProviderProxyTransport;
}

/**
 * The runtime provider data channel. Authentication is exclusively the first-frame single-use
 * ticket: this endpoint answers no HTTP semantics, honors no Authorization header, and rejects a
 * ticket smuggled through the URL query, so a bare bearer credential is never usable here.
 */
export function registerRuntimeProviderProxyRoutes(
  app: FastifyInstance,
  options: RuntimeProviderProxyRoutesOptions,
): void {
  app.get(RUNTIME_PROVIDER_PROXY_PATH, { websocket: true }, (socket, request) => {
    const queryIndex = request.raw.url?.indexOf("?") ?? -1;
    if (queryIndex >= 0) {
      socket.close(4400, "The provider proxy forbids URL credentials");
      return;
    }
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      socket.close(4401, "The provider proxy requires a first-frame ticket");
      return;
    }
    options.transport.attach(socket);
  });
}
