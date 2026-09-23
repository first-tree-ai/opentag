import {
  WEB_TOOLS_PROTOCOL_VERSION,
  type WebFetchExecutionRequest,
  type WebSearchExecutionRequest,
} from "@opentag/shared";
import { WebToolsClientError, type WebToolsServerClient } from "./web-tools-client.js";
import { type WebGatewayDispatch, WebGatewayDispatchError } from "./web-tools-gateway.js";

/**
 * Bind one execution's Server web client to the Sandbox-facing gateway contract.
 *
 * Both trusted web boundaries need exactly this: the Local daemon per-execution Unix socket and the
 * Cloud Runner parent's per-execution `sandbox exec` duplex pipe. The execution identity is injected
 * here from the trusted parent — the Sandbox only ever supplies the runtime-generated `toolCallId`
 * and validated business parameters — and a bounded client failure is translated into the gateway's
 * own error type so the Sandbox sees one redacted vocabulary.
 */
export function createExecutionWebDispatch(input: {
  readonly client: WebToolsServerClient;
  readonly executionId: string;
}): WebGatewayDispatch {
  return async (dispatch, signal) => {
    const request = {
      protocolVersion: WEB_TOOLS_PROTOCOL_VERSION,
      executionId: input.executionId,
      toolCallId: dispatch.toolCallId,
      ...dispatch.params,
    };
    try {
      return dispatch.operation === "search"
        ? await input.client.search({
            request: request as WebSearchExecutionRequest,
            remainingMs: dispatch.remainingMs,
            signal,
          })
        : await input.client.fetch({
            request: request as WebFetchExecutionRequest,
            remainingMs: dispatch.remainingMs,
            signal,
          });
    } catch (error) {
      if (error instanceof WebToolsClientError) {
        throw new WebGatewayDispatchError(error.code, error.message, {
          ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
        });
      }
      throw error;
    }
  };
}
