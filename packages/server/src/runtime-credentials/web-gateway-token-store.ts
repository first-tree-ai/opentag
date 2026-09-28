import {
  type RuntimeExecutionBearerRecord,
  RuntimeExecutionBearerStore,
  RuntimeExecutionBearerStoreCapacityError,
  type RuntimeExecutionBearerStoreOptions,
} from "./execution-bearer-store.js";

/** Distinguishes a web execution bearer from every other OpenTag credential in a log or a config. */
export const WEB_GATEWAY_TOKEN_PREFIX = "otwg_";

export type RuntimeWebGatewayTokenRecord = RuntimeExecutionBearerRecord;

export type RuntimeWebGatewayTokenStoreOptions = Omit<
  RuntimeExecutionBearerStoreOptions,
  "tokenPrefix" | "capacityError"
>;

export class RuntimeWebGatewayTokenStoreCapacityError extends RuntimeExecutionBearerStoreCapacityError {
  constructor() {
    super("The web gateway token store is full");
    this.name = "RuntimeWebGatewayTokenStoreCapacityError";
  }
}

/**
 * Hash-only bounded index of execution web bearers, one live token per execution.
 *
 * The mechanics live in {@link RuntimeExecutionBearerStore}; this is the `otwg_` family. A Cloud
 * Runner never receives the deployment Router key: it receives this short-lived value, holds it in
 * the trusted parent process only, and presents it to the two fixed web routes on behalf of one
 * exact execution. The token is revoked wherever an execution closes, so it cannot outlive the turn.
 */
export class RuntimeWebGatewayTokenStore extends RuntimeExecutionBearerStore {
  constructor(options: RuntimeWebGatewayTokenStoreOptions = {}) {
    super({
      ...options,
      tokenPrefix: WEB_GATEWAY_TOKEN_PREFIX,
      capacityError: () => new RuntimeWebGatewayTokenStoreCapacityError(),
    });
  }
}
