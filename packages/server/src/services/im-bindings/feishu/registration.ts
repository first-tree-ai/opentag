import { registerApp } from "@larksuiteoapi/node-sdk";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { ExternalCallPolicy } from "../../im/external-call-policy.js";

/**
 * How long registration may stay open, as a backstop rather than a budget.
 *
 * Every other provider call under the policy is a request: something we send, something that answers,
 * and a deadline that says how long a machine may take. Registration is not that. Its promise settles
 * only after a person has scanned a code, signed in, approved the scopes and let the app be created,
 * against a device code the vendor issues with an `expires_in` of an hour. A request-shaped deadline
 * measures the wrong thing entirely — it times the human — and at sixty seconds it fails nearly
 * everyone, before they have finished doing what we asked them to do.
 *
 * So this sits deliberately above the device code's own lifetime. The SDK stops polling and rejects
 * with `expired_token` when that code expires, which is the limit that should end a registration; the
 * policy is left holding only the case where that never happens.
 */
const REGISTRATION_DEADLINE_MS = 65 * 60 * 1_000;

export interface FeishuAppProfile {
  name: string;
  description: string;
  avatarUrl?: string;
}

export interface FeishuRegistrationResult {
  appId: string;
  appSecret: string;
  teamBrand?: "feishu" | "lark";
}

export interface FeishuRegistration {
  qrReady: Promise<{ url: string; expiresAt: Date }>;
  result: Promise<FeishuRegistrationResult>;
  abort(): void;
}

export interface FeishuRegistrationGateway {
  start(input: {
    profile: FeishuAppProfile;
    intent: "create" | "reauthorize" | "replace";
    existingAppId?: string;
    receiveMode: "all_message" | "mention_only";
  }): FeishuRegistration;
}

export class DefaultFeishuRegistrationGateway implements FeishuRegistrationGateway {
  readonly #registerApp: typeof registerApp;
  readonly #policy: ExternalCallPolicy;

  constructor(
    register: typeof registerApp = registerApp,
    policy: ExternalCallPolicy = new ExternalCallPolicy({
      allowedHosts: ["open.feishu.cn", "open.larksuite.com"],
    }),
  ) {
    this.#registerApp = register;
    this.#policy = policy;
  }

  start(input: {
    profile: FeishuAppProfile;
    intent: "create" | "reauthorize" | "replace";
    existingAppId?: string;
    receiveMode: "all_message" | "mention_only";
  }): FeishuRegistration {
    const controller = new AbortController();
    let resolveQr: (value: { url: string; expiresAt: Date }) => void = () => undefined;
    let rejectQr: (reason: unknown) => void = () => undefined;
    const qrReady = new Promise<{ url: string; expiresAt: Date }>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });
    const result = this.#policy
      .run(
        "feishu.registration",
        (signal) =>
          this.#registerApp({
            ...(input.intent === "reauthorize" && input.existingAppId
              ? { appId: input.existingAppId }
              : { createOnly: false }),
            signal: (() => {
              const linked = new AbortController();
              const abort = () => linked.abort(controller.signal.reason);
              if (controller.signal.aborted) abort();
              else controller.signal.addEventListener("abort", abort, { once: true });
              signal.addEventListener("abort", () => linked.abort(signal.reason), { once: true });
              return linked.signal;
            })(),
            source: "opentag",
            appPreset: {
              name: input.profile.name,
              desc: input.profile.description,
              ...(input.profile.avatarUrl ? { avatar: input.profile.avatarUrl } : {}),
            },
            addons: {
              preset: true,
              // receiveMode gates Agent delivery, not the Bot authority ceiling or durable ImMessage history.
              scopes: { tenant: [...FEISHU_REQUIRED_TENANT_SCOPES] },
              events: { items: { tenant: ["im.message.receive_v1", "im.message.recalled_v1"] } },
            },
            onQRCodeReady: ({ url, expireIn }) => {
              resolveQr({ url, expiresAt: new Date(Date.now() + expireIn * 1000) });
            },
          }),
        {
          maxAttempts: 1,
          timeoutMs: REGISTRATION_DEADLINE_MS,
          circuitKey: "feishu:registration",
          /*
           * Handed to the policy rather than only to the SDK, so abandoning a registration reads as
           * the caller withdrawing rather than the provider failing. Switching brand cancels and
           * reissues, which makes cancellation an ordinary act here rather than an exceptional one.
           */
          signal: controller.signal,
        },
      )
      .then((credentials) => ({
        appId: credentials.client_id,
        appSecret: credentials.client_secret,
        teamBrand: credentials.user_info?.tenant_brand,
      }))
      .catch((error) => {
        rejectQr(error);
        throw error;
      });
    return { qrReady, result, abort: () => controller.abort() };
  }
}
