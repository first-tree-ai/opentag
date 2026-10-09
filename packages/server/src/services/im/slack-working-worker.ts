import { SlackThreadStatusError } from "./slack-thread-status-error.js";

export { SlackThreadStatusError } from "./slack-thread-status-error.js";

import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, slackInstallations } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ApplicationCipher } from "../crypto.js";
import { decodeSlackCredential } from "../im-bindings/credential-material.js";
import type { DefaultSlackApiClient } from "../im-bindings/slack/default-api-client.js";
import { ExternalCallPolicyError } from "./external-call-policy.js";
import type { SlackWorkingStore, WorkingTarget } from "./slack-working-store.js";

export function slackWorkingCredentialResolver(database: DatabaseClient, cipher: ApplicationCipher) {
  return async (target: WorkingTarget): Promise<string | undefined> => {
    const [row] = await database
      .select({ installation: slackInstallations })
      .from(slackInstallations)
      .innerJoin(imBindings, eq(imBindings.slackInstallationId, slackInstallations.id))
      .where(
        and(
          eq(slackInstallations.id, target.installationId),
          eq(imBindings.id, target.bindingId),
          eq(slackInstallations.status, "active"),
          eq(imBindings.status, "active"),
          eq(slackInstallations.credentialGeneration, target.credentialGeneration),
          eq(imBindings.credentialGeneration, target.credentialGeneration),
        ),
      )
      .limit(1);
    if (!row) return;
    const credential = decodeSlackCredential(cipher, row.installation.encryptedCredential, {
      slackInstallationId: target.installationId,
    });
    if (credential?.grantedScopes.includes("chat:write")) return credential.botAccessToken;
  };
}

/** Independent outbox pump: no Slack request is awaited by the Agent or Turn Report. */
export class SlackWorkingWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pass: Promise<void> | undefined;
  #stopped = false;
  constructor(
    readonly options: {
      store: Pick<SlackWorkingStore, "claim" | "desired" | "settle" | "ownsClaim">;
      token(target: WorkingTarget): Promise<string | undefined>;
      api: Pick<DefaultSlackApiClient, "setThreadStatus">;
      logger?: Pick<ServiceLogger, "warn">;
    },
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, 1_000);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pass;
  }

  runOnce(): Promise<void> {
    this.#pass ??= this.#pump()
      .catch(() => {
        this.options.logger?.warn({ code: "SLACK_WORKING_PUMP_FAILED" }, "Slack working status pump failed");
      })
      .finally(() => {
        this.#pass = undefined;
      });
    return this.#pass;
  }

  async #pump(): Promise<void> {
    for (let count = 0; count < 8 && !this.#stopped; count += 1) {
      const target = await this.options.store.claim();
      if (!target) return;
      await this.#apply(target);
    }
  }

  async #apply(target: WorkingTarget): Promise<void> {
    let working = target.working;
    try {
      const token = await this.options.token(target);
      if (!token) {
        await this.options.store.settle(target, { working: false, delayMs: 0, disabled: true });
        return;
      }
      working = await this.options.store.desired(target);
      if (!(await this.options.store.ownsClaim(target))) return;
      // Always clear an unknown projection, including a process crash after a successful API call.
      await this.options.api.setThreadStatus({
        token,
        channelId: target.channelId,
        threadTs: target.threadTs,
        status: working ? "is working" : "",
      });
      await this.options.store.settle(target, { working, delayMs: 45_000, dormant: !working });
    } catch (error) {
      await this.#failed(target, error);
    }
  }

  async #failed(target: WorkingTarget, error: unknown): Promise<void> {
    const known = error instanceof SlackThreadStatusError;
    const rateLimited = known && error.code === "ratelimited";
    const circuitOpen = error instanceof ExternalCallPolicyError && error.code === "IM_PROVIDER_CIRCUIT_OPEN";
    const deferred = rateLimited || circuitOpen;
    const permanent =
      known &&
      ["missing_scope", "invalid_auth", "token_revoked", "channel_not_found", "not_in_channel"].includes(error.code);
    const delayMs =
      known && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : circuitOpen
          ? 30_000
          : Math.min(30_000, 2_000 * 2 ** Math.min(target.failures, 4));
    this.options.logger?.warn(
      { code: "SLACK_WORKING_API_FAILED", reason: known ? error.code : "upstream_unavailable" },
      "Slack working status request failed",
    );
    await this.options.store.settle(target, {
      working: target.working,
      delayMs,
      failed: true,
      disabled: permanent || (!deferred && target.failures >= 3),
      deferred,
      ...(rateLimited ? { cooldownMs: delayMs } : {}),
    });
  }
}
