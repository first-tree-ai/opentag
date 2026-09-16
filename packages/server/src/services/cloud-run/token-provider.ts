import { readBoundedJson } from "./bounded-json.js";
import { CloudRunAdminError } from "./errors.js";

/**
 * Google access-token acquisition for Cloud Admin calls. The adapter takes an injected provider;
 * production wiring uses the GCE metadata server of the service account the Server runs as — a
 * small, well-documented, source-owned credential provider with no `gcloud` shell-out and no
 * credential file access. A static provider exists only for the acceptance harness, which runs
 * the Server off-GCP with a short-lived operator-supplied token passed through the environment.
 */

export type AccessTokenProvider = () => Promise<string>;

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const METADATA_TIMEOUT_MS = 5_000;
/** Refresh this far ahead of the stated expiry so a call never rides a nearly-dead token. */
const EXPIRY_MARGIN_MS = 60_000;

export function createStaticTokenProvider(token: string): AccessTokenProvider {
  return async () => token;
}

export interface MetadataTokenProviderOptions {
  fetchImpl?: typeof fetch;
  metadataTokenUrl?: string;
  now?: () => number;
}

export function createMetadataServerTokenProvider(options: MetadataTokenProviderOptions = {}): AccessTokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.metadataTokenUrl ?? METADATA_TOKEN_URL;
  const now = options.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const acquire = async (): Promise<string> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    } catch {
      throw new CloudRunAdminError("credential", "Metadata server token request failed");
    }
    if (!response.ok) {
      throw new CloudRunAdminError("credential", `Metadata server token request returned HTTP ${response.status}`, {
        status: response.status,
      });
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response, 16 * 1024);
    } catch {
      throw new CloudRunAdminError("credential", "Metadata server token response was not JSON");
    }
    const record = (body && typeof body === "object" ? body : {}) as {
      access_token?: unknown;
      expires_in?: unknown;
      token_type?: unknown;
    };
    if (
      typeof record.access_token !== "string" ||
      record.access_token.length === 0 ||
      record.access_token.length > 8192
    ) {
      throw new CloudRunAdminError("credential", "Metadata server token response carried no access token");
    }
    if (
      record.token_type !== "Bearer" ||
      typeof record.expires_in !== "number" ||
      !Number.isFinite(record.expires_in) ||
      record.expires_in <= 60 ||
      record.expires_in > 86400
    ) {
      throw new CloudRunAdminError("credential", "Metadata server returned an invalid token lifetime or type");
    }
    const expiresIn = record.expires_in;
    cached = { token: record.access_token, expiresAt: now() + expiresIn * 1000 - EXPIRY_MARGIN_MS };
    return record.access_token;
  };

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (!inFlight) {
      inFlight = acquire().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}
