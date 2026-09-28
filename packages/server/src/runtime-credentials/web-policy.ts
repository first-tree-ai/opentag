import type { RuntimeWebServiceScope } from "@opentag/shared";

/**
 * Platform `web` service policy. The service is a deployment-wide default: when the deployment
 * configured a Router origin and web-only key, every valid active Account execution is web-capable
 * exactly like platform LLM access. There is no per-Account mapping, no per-user opt-in, and no
 * user-facing setting; a deployment with no configured Router key denies the service rather than
 * falling back.
 */
export interface RuntimeWebServicePolicy {
  /** Exact scopes granted at execution open; undefined when the deployment has no web config. */
  authorizeWeb(input: { accountId: string }): readonly RuntimeWebServiceScope[] | undefined;
}

export interface RuntimeWebRouterKeyResolution {
  /**
   * The one deployment-wide Router web-only key. Live secret material: it is read from deployment
   * config per dispatch and is never cached onto an execution record or sent to a Sandbox.
   */
  readonly routerKey: string;
}

export interface RuntimeWebRouterKeyResolver {
  /** Fresh per-request key resolution from deployment config, or undefined when disabled. */
  resolveRouterKey(input: { accountId: string }): RuntimeWebRouterKeyResolution | undefined;
}

export const RUNTIME_WEB_SERVICE_SCOPES: readonly RuntimeWebServiceScope[] = ["web:search", "web:fetch"];

export interface RuntimeWebPolicyConfig {
  /** The deployment's single Router web-only key. Key material lives only in this config. */
  readonly routerKey: string;
}

/**
 * The configured web policy. Both directions come from the same deployment config, so a grant and
 * the credential that serves it can never disagree, and no caller-controlled tenant, key, or target
 * exists anywhere in the chain.
 */
export class ConfigRuntimeWebPolicy implements RuntimeWebServicePolicy, RuntimeWebRouterKeyResolver {
  readonly #routerKey: string;

  constructor(config: RuntimeWebPolicyConfig) {
    this.#routerKey = config.routerKey;
  }

  authorizeWeb(_input: { accountId: string }): readonly RuntimeWebServiceScope[] | undefined {
    return RUNTIME_WEB_SERVICE_SCOPES;
  }

  resolveRouterKey(_input: { accountId: string }): RuntimeWebRouterKeyResolution | undefined {
    return { routerKey: this.#routerKey };
  }
}
