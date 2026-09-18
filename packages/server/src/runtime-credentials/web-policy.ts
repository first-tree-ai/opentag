import type { RuntimeWebServiceScope } from "@opentag/shared";

/**
 * Platform `web` service policy. The service is deployment-gated: an Account becomes web-capable
 * only through explicit configuration mapping the Account to its Router tenant. There is no
 * shared default tenant — a missing mapping denies the service rather than falling back.
 */
export interface RuntimeWebServicePolicy {
  /** Exact scopes granted at execution open; undefined when the Account has no web mapping. */
  authorizeWeb(input: { accountId: string }): readonly RuntimeWebServiceScope[] | undefined;
}

/** Router tenant binding for one dispatch. The key is live deployment secret material. */
export interface RuntimeWebTenantResolution {
  tenantId: string;
  routerKey: string;
}

export interface RuntimeWebTenantResolver {
  /** Fresh per-request tenant resolution; keys are never cached onto execution records. */
  resolveTenant(input: { accountId: string }): RuntimeWebTenantResolution | undefined;
}

export const RUNTIME_WEB_SERVICE_SCOPES: readonly RuntimeWebServiceScope[] = ["web:search", "web:fetch"];

export interface RuntimeWebPolicyConfig {
  /** accountId → Router tenant binding. Key material lives only in this deployment config. */
  readonly tenants: ReadonlyMap<string, RuntimeWebTenantResolution>;
}

/**
 * The configured web policy. Both directions come from the same map so an Account that can open
 * a web execution always resolves its own tenant at dispatch, and no other Account's tenant can
 * ever be selected — there is no caller-controlled tenant input anywhere in the chain.
 */
export class ConfigRuntimeWebPolicy implements RuntimeWebServicePolicy, RuntimeWebTenantResolver {
  readonly #tenants: ReadonlyMap<string, RuntimeWebTenantResolution>;

  constructor(config: RuntimeWebPolicyConfig) {
    this.#tenants = config.tenants;
  }

  authorizeWeb(input: { accountId: string }): readonly RuntimeWebServiceScope[] | undefined {
    return this.#tenants.has(input.accountId) ? RUNTIME_WEB_SERVICE_SCOPES : undefined;
  }

  resolveTenant(input: { accountId: string }): RuntimeWebTenantResolution | undefined {
    return this.#tenants.get(input.accountId);
  }
}
