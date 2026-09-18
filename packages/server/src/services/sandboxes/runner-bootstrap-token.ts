import { errors, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { z } from "zod";

/**
 * Scoped, short-lived Runner bootstrap bearer token. Signed with the Server's existing HS256
 * signing facility (`jose`, same construction as the Slack OAuth state signer) but under a
 * dedicated audience, so a bootstrap token can never be replayed as any other credential and no
 * other credential can be replayed here. The claims pin the exact Sandbox environment allocation:
 * sandbox, session, environment generation, and the full Cloud Run resource name. Verification is
 * only the first step — the Server still validates the CURRENT database allocation on every
 * connect, so an unexpired token from a superseded generation is useless.
 *
 * The custom claims are strict: JOSE verifies the registered envelope claims (`iss`/`aud`/`exp`
 * and the HS256 algorithm), then this module selects ONLY the custom fields. A strict schema over
 * the whole payload would reject every freshly issued token because `iss`/`aud`/`iat`/`exp` ride
 * alongside the custom claims; a permissive schema would silently accept a token missing the
 * claims that pin the allocation.
 */

const BOOTSTRAP_AUDIENCE = "opentag-cloud-runner";
const BOOTSTRAP_ISSUER = "opentag";
const BOOTSTRAP_DEFAULT_TTL_SECONDS = 1_800;

const RunnerBootstrapClaimsSchema = z
  .object({
    sandboxId: z.string().uuid(),
    sessionId: z.string().uuid(),
    environmentGeneration: z.number().int().positive(),
    resourceName: z.string().min(1).max(1024),
  })
  .strict();

export type RunnerBootstrapClaims = z.infer<typeof RunnerBootstrapClaimsSchema>;

export class RunnerBootstrapTokenError extends Error {
  constructor() {
    super("The Runner bootstrap token is invalid or expired");
    this.name = "RunnerBootstrapTokenError";
  }
}

export class RunnerBootstrapTokenService {
  readonly #key: Uint8Array;
  readonly #now: () => Date;
  readonly #ttlSeconds: number;

  constructor(secret: string, options: { now?: () => Date; ttlSeconds?: number } = {}) {
    this.#key = new TextEncoder().encode(secret);
    this.#now = options.now ?? (() => new Date());
    this.#ttlSeconds = options.ttlSeconds ?? BOOTSTRAP_DEFAULT_TTL_SECONDS;
  }

  /** Token lifetime in milliseconds; the control channel renews at half of this. */
  get ttlMs(): number {
    return this.#ttlSeconds * 1_000;
  }

  async issue(claims: RunnerBootstrapClaims): Promise<string> {
    const payload = RunnerBootstrapClaimsSchema.parse(claims);
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(BOOTSTRAP_ISSUER)
      .setAudience(BOOTSTRAP_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.#ttlSeconds)
      .sign(this.#key);
  }

  async verify(token: string): Promise<RunnerBootstrapClaims> {
    try {
      return this.#claims((await this.#verifyJwt(token)).payload);
    } catch {
      throw new RunnerBootstrapTokenError();
    }
  }

  /**
   * Renewal-only evidence, NEVER an authenticated channel or HTTP authority. JOSE checks the
   * signature, algorithm, issuer, audience and nbf before throwing JWTExpired. The caller must
   * additionally prove the exact allocation is still current and its tracked Cloud UID exists,
   * then issue a fresh token and require a new ordinary handshake. Allocation removal revokes
   * this renewal ability, including across Server restarts; no separate refresh-token store.
   */
  async expiredClaimsForRenewal(token: string): Promise<RunnerBootstrapClaims | undefined> {
    try {
      await this.#verifyJwt(token);
    } catch (error) {
      if (error instanceof errors.JWTExpired && error.claim === "exp") {
        try {
          return this.#claims(error.payload);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  #verifyJwt(token: string) {
    return jwtVerify(token, this.#key, {
      algorithms: ["HS256"],
      audience: BOOTSTRAP_AUDIENCE,
      currentDate: this.#now(),
      issuer: BOOTSTRAP_ISSUER,
      requiredClaims: ["exp", "iat"],
    });
  }

  #claims(payload: JWTPayload): RunnerBootstrapClaims {
    if (
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.exp <= payload.iat
    )
      throw new RunnerBootstrapTokenError();
    return RunnerBootstrapClaimsSchema.parse({
      sandboxId: payload.sandboxId,
      sessionId: payload.sessionId,
      environmentGeneration: payload.environmentGeneration,
      resourceName: payload.resourceName,
    });
  }
}
