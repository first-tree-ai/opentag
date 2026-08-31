import { registerApp } from "@larksuiteoapi/node-sdk";
import { FEISHU_REQUIRED_TENANT_SCOPES, type FeishuBrand } from "@opentag/shared";

/**
 * The account domains the registration device-flow runs against, one per regional brand.
 *
 * These are deliberately not `feishuDomainForWorkspaceBrand`: that helper returns the *open API*
 * host an authorized binding talks to afterwards, while registration begins on the accounts host,
 * and the two differ. Sharing one helper between them would look like consolidation and quietly
 * point the QR code at an endpoint that has no registration route.
 */
const REGISTRATION_DOMAINS: Record<FeishuBrand, string> = {
  feishu: "accounts.feishu.cn",
  lark: "accounts.larksuite.com",
};

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

export interface FeishuRegistrationStart {
  profile: FeishuAppProfile;
  intent: "create" | "reauthorize" | "replace";
  existingAppId?: string;
  receiveMode: "all_message" | "mention_only";
  /**
   * Which brand's accounts domain to mint the code against. The SDK's own default is Feishu, and
   * its polling loop moves to the Lark domain by itself once the authorization result says the
   * tenant is a Lark one — but only in that direction. Choosing Lark here therefore gives up that
   * recovery, which is why the choice is offered to the reader rather than only inferred.
   */
  brand: FeishuBrand;
}

export interface FeishuRegistrationGateway {
  start(input: FeishuRegistrationStart): FeishuRegistration;
}

export class DefaultFeishuRegistrationGateway implements FeishuRegistrationGateway {
  readonly #registerApp: typeof registerApp;

  constructor(register: typeof registerApp = registerApp) {
    this.#registerApp = register;
  }

  start(input: FeishuRegistrationStart): FeishuRegistration {
    const controller = new AbortController();
    let resolveQr: (value: { url: string; expiresAt: Date }) => void = () => undefined;
    let rejectQr: (reason: unknown) => void = () => undefined;
    const qrReady = new Promise<{ url: string; expiresAt: Date }>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });
    const result = this.#registerApp({
      ...(input.intent === "reauthorize" && input.existingAppId
        ? { appId: input.existingAppId }
        : { createOnly: false }),
      signal: controller.signal,
      domain: REGISTRATION_DOMAINS[input.brand],
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
    })
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
