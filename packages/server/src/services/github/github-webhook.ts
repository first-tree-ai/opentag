/*
 * GitHub App webhook ingress: raw-body HMAC-SHA256 verification local to the endpoint, then a
 * conservative mapping from provider-attested events to connection maintenance.
 *
 * Events only ever push connections toward safety: an authorization revocation invalidates
 * fail-closed (the platform attested the UAT is dead), and installation changes mark an immediate
 * authoritative recheck — the recheck worker, never the payload, decides what is still admitted.
 * A webhook therefore cannot restore access, and a forged or replayed body cannot even mark a
 * recheck, because the HMAC covers the exact raw bytes with the deployment webhook secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitHubConnectionRecheckStore } from "./github-recheck-store.js";

const MAX_DELIVERY_ID_LENGTH = 255;
const MAX_EVENT_NAME_LENGTH = 100;
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,18}$/;

export const GITHUB_WEBHOOK_EVENTS = {
  APP_AUTHORIZATION: "github_app_authorization",
  INSTALLATION: "installation",
  INSTALLATION_REPOSITORIES: "installation_repositories",
} as const;

export type GitHubWebhookVerdict =
  | { status: "processed"; invalidatedConnections: number; recheckMarkedConnections: number }
  | { status: "ignored" }
  | { status: "rejected" };

export interface GitHubWebhookServiceOptions {
  webhookSecret: string;
  recheckStore: GitHubConnectionRecheckStore;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && DECIMAL_ID_PATTERN.test(value)) return value;
  return null;
}

export class GitHubWebhookService {
  readonly #webhookSecret: string;
  readonly #recheckStore: GitHubConnectionRecheckStore;
  readonly #now: () => Date;

  constructor(options: GitHubWebhookServiceOptions) {
    if (typeof options.webhookSecret !== "string" || options.webhookSecret.length === 0) {
      throw new Error("The GitHub webhook secret must be configured");
    }
    this.#webhookSecret = options.webhookSecret;
    this.#recheckStore = options.recheckStore;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Verifies and applies one delivery. The raw body is the exact bytes GitHub signed; the event
   * name and delivery ID are bounded before any processing. Payload contents are never logged.
   */
  async handle(input: {
    rawBody: Buffer;
    signature256: string | undefined;
    event: string | undefined;
    deliveryId: string | undefined;
  }): Promise<GitHubWebhookVerdict> {
    if (!this.#verifySignature(input.rawBody, input.signature256)) return { status: "rejected" };
    const event = boundedHeaderValue(input.event, MAX_EVENT_NAME_LENGTH);
    if (event === null) return { status: "rejected" };
    if (boundedHeaderValue(input.deliveryId, MAX_DELIVERY_ID_LENGTH) === null) return { status: "rejected" };
    const payload = this.#parsePayload(input.rawBody);
    if (payload === null) return { status: "rejected" };
    const action = typeof payload.action === "string" ? payload.action : null;

    if (event === GITHUB_WEBHOOK_EVENTS.APP_AUTHORIZATION) return this.#handleAuthorizationEvent(payload, action);
    if (event === GITHUB_WEBHOOK_EVENTS.INSTALLATION) return this.#handleInstallationEvent(payload, action);
    if (event === GITHUB_WEBHOOK_EVENTS.INSTALLATION_REPOSITORIES)
      return this.#handleRepositoriesEvent(payload, action);
    return { status: "ignored" };
  }

  #parsePayload(rawBody: Buffer): Record<string, unknown> | null {
    try {
      const payload: unknown = JSON.parse(rawBody.toString("utf8"));
      return isRecord(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  /** A revoked user authorization invalidates that user's connections fail-closed. */
  async #handleAuthorizationEvent(
    payload: Record<string, unknown>,
    action: string | null,
  ): Promise<GitHubWebhookVerdict> {
    if (action !== "revoked") return { status: "ignored" };
    // The revoking user is the sender; only their active connections invalidate.
    const githubUserId = isRecord(payload.sender) ? decimalId(payload.sender.id) : null;
    if (githubUserId === null) return { status: "ignored" };
    const connectionIds = await this.#recheckStore.listActiveConnectionIdsByGitHubUser(githubUserId);
    const invalidated = await this.#recheckStore.invalidateActiveConnections({
      connectionIds,
      errorCode: "GITHUB_CREDENTIAL_INVALID",
    });
    return { status: "processed", invalidatedConnections: invalidated, recheckMarkedConnections: 0 };
  }

  /** Installation changes only ever pull an authoritative recheck forward. */
  async #handleInstallationEvent(
    payload: Record<string, unknown>,
    action: string | null,
  ): Promise<GitHubWebhookVerdict> {
    if (
      action !== "deleted" &&
      action !== "suspend" &&
      action !== "unsuspend" &&
      action !== "new_permissions_accepted"
    ) {
      return { status: "ignored" };
    }
    return this.#markInstallationRecheck(payload.installation);
  }

  async #handleRepositoriesEvent(
    payload: Record<string, unknown>,
    action: string | null,
  ): Promise<GitHubWebhookVerdict> {
    if (action !== "added" && action !== "removed") return { status: "ignored" };
    return this.#markInstallationRecheck(payload.installation);
  }

  async #markInstallationRecheck(installation: unknown): Promise<GitHubWebhookVerdict> {
    const installationId = isRecord(installation) ? decimalId(installation.id) : null;
    if (installationId === null) return { status: "ignored" };
    const connectionIds = await this.#recheckStore.listActiveConnectionIdsByInstallation(installationId);
    const marked = await this.#recheckStore.markRecheckDue({ connectionIds, dueAt: this.#now() });
    return { status: "processed", invalidatedConnections: 0, recheckMarkedConnections: marked };
  }

  #verifySignature(rawBody: Buffer, signature256: string | undefined): boolean {
    if (typeof signature256 !== "string" || !/^sha256=[0-9a-f]{64}$/.test(signature256)) return false;
    const expected = createHmac("sha256", this.#webhookSecret).update(rawBody).digest("hex");
    const presented = signature256.slice("sha256=".length);
    const left = Buffer.from(presented, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }
}

function boundedHeaderValue(value: string | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}
