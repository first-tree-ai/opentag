import {
  type RuntimeExecutionBearerRecord,
  RuntimeExecutionBearerStore,
  RuntimeExecutionBearerStoreCapacityError,
  type RuntimeExecutionBearerStoreOptions,
} from "./execution-bearer-store.js";

/** Distinguishes an MCP gateway bearer from every other OpenTag credential in a log or a config. */
export const MCP_GATEWAY_TOKEN_PREFIX = "otmg_";

export type RuntimeMcpGatewayTokenRecord = RuntimeExecutionBearerRecord;

export type RuntimeMcpGatewayTokenStoreOptions = Omit<
  RuntimeExecutionBearerStoreOptions,
  "tokenPrefix" | "capacityError"
>;

export class RuntimeMcpGatewayTokenStoreCapacityError extends RuntimeExecutionBearerStoreCapacityError {
  constructor() {
    super("The MCP gateway token store is full");
    this.name = "RuntimeMcpGatewayTokenStoreCapacityError";
  }
}

/**
 * Hash-only bounded index of MCP gateway bearers, one live token per execution.
 *
 * The mechanics live in {@link RuntimeExecutionBearerStore}; this is the `otmg_` family. The
 * credential a provider CLI presents is a 256-bit random value tied to one execution, the Server
 * keeps only its SHA-256 digest, and the token is revoked wherever an execution closes. A token
 * read out of a config file by a prompt-injected Agent buys no lasting access, which is what makes
 * writing it to disk acceptable at all.
 */
export class RuntimeMcpGatewayTokenStore extends RuntimeExecutionBearerStore {
  constructor(options: RuntimeMcpGatewayTokenStoreOptions = {}) {
    super({
      ...options,
      tokenPrefix: MCP_GATEWAY_TOKEN_PREFIX,
      capacityError: () => new RuntimeMcpGatewayTokenStoreCapacityError(),
    });
  }
}
