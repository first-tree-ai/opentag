import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { computers } from "../db/schema/index.js";
import { AuthServiceError } from "../services/auth/index.js";
import type { ComputerAuthContext, ComputerAuthVerifier } from "../services/computers/index.js";

/**
 * Cloud control credentials are deployment-issued secrets presented by the trusted Cloud control
 * plane. They are never copied into Sandboxes and never derived from Local machine tokens.
 */
export const CLOUD_CONTROL_CREDENTIAL_PREFIX = "otcloud-control.";

export interface TrustedCloudControlIdentity {
  /**
   * The deployment-issued credential id. Trusted production verifiers always return it; it is
   * optional only for legacy test fakes, and the auth verifier fails closed when it is missing
   * so a Cloud context never invents one.
   */
  credentialId?: string;
  computerId: string;
  installationId: string;
}

/**
 * Deployment-injected credential resolver for the trusted Cloud control path. The future
 * Computer/Cloud orchestration owns issuance, rotation, and revocation; without a verifier,
 * Cloud control authentication does not exist and Cloud executions cannot open. There is no
 * implicit self-issued credential and no Local-token fallback.
 */
export interface TrustedCloudControlVerifier {
  verifyControlCredential(credential: string): Promise<TrustedCloudControlIdentity | undefined>;
}

/** The stable facts of one authenticated Cloud control credential, re-checked for liveness. */
export interface TrustedCloudControlFacts {
  credentialId: string;
  computerId: string;
  installationId: string;
}

/**
 * The trusted Cloud control port consumed by the integration runtime: credential verification
 * plus the live activity/revocation check re-read on control frames and data requests. Both
 * halves belong to the Computer/Cloud orchestration; this composition only consumes them.
 */
export interface TrustedCloudControlAuthority extends TrustedCloudControlVerifier {
  isActive(identity: TrustedCloudControlFacts): Promise<boolean> | boolean;
}

function cloudControlRejected(): AuthServiceError {
  return new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The Cloud control credential is invalid", 401);
}

/**
 * Composite Computer authentication: Local machine tokens keep the existing database path, while
 * `otcloud-control.*` credentials are resolved by the injected verifier and bound to the existing
 * logical Cloud Computer row (`kind = 'cloud'`, stable Server-managed installation identity).
 */
export class KindAwareComputerAuthVerifier implements ComputerAuthVerifier {
  readonly #machineAuth: ComputerAuthVerifier;
  readonly #database: DatabaseClient;
  readonly #cloudVerifier?: TrustedCloudControlVerifier;

  constructor(
    machineAuth: ComputerAuthVerifier,
    database: DatabaseClient,
    cloudVerifier?: TrustedCloudControlVerifier,
  ) {
    this.#machineAuth = machineAuth;
    this.#database = database;
    this.#cloudVerifier = cloudVerifier;
  }

  async verifyMachineToken(machineToken: string): Promise<ComputerAuthContext> {
    if (!machineToken.startsWith(CLOUD_CONTROL_CREDENTIAL_PREFIX)) {
      return this.#machineAuth.verifyMachineToken(machineToken);
    }
    if (!this.#cloudVerifier) throw cloudControlRejected();
    const identity = await this.#cloudVerifier.verifyControlCredential(
      machineToken.slice(CLOUD_CONTROL_CREDENTIAL_PREFIX.length),
    );
    if (!identity) throw cloudControlRejected();
    if (!identity.credentialId) throw cloudControlRejected();
    const [row] = await this.#database
      .select({
        id: computers.id,
        kind: computers.kind,
        currentInstallationId: computers.currentInstallationId,
      })
      .from(computers)
      .where(eq(computers.id, identity.computerId))
      .limit(1);
    if (row?.kind !== "cloud" || row.currentInstallationId !== identity.installationId) {
      throw cloudControlRejected();
    }
    return {
      credentialId: identity.credentialId,
      computerId: row.id,
      installationId: row.currentInstallationId,
      kind: "cloud",
    };
  }
}
