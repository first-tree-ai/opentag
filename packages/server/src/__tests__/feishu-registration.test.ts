import type { registerApp } from "@larksuiteoapi/node-sdk";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";

import { safeFeishuSetupErrorCode } from "../services/im-bindings/feishu/errors.js";
import { DefaultFeishuRegistrationGateway } from "../services/im-bindings/feishu/registration.js";

interface RegistrationOptions {
  appId?: string;
  createOnly?: boolean;
  domain?: string;
  signal: AbortSignal;
  appPreset: { name: string; desc: string };
  addons: { preset: boolean; scopes: { tenant: string[]; user?: string[] }; events: { items: { tenant: string[] } } };
  onQRCodeReady(input: { url: string; expireIn: number }): void;
}

describe("Feishu registration", () => {
  it.each(["create", "replace"] as const)("allows an existing or new App for %s", async (intent) => {
    const register = vi.fn(async (rawOptions: unknown) => {
      const options = rawOptions as RegistrationOptions;
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr/create", expireIn: 60 });
      return { client_id: "cli_new", client_secret: "secret", user_info: { tenant_brand: "feishu" } };
    });
    const registration = new DefaultFeishuRegistrationGateway(register as typeof registerApp).start({
      profile: { name: "Assistant", description: "OpenTag Agent: Assistant" },
      intent,
      receiveMode: "all_message",
      brand: "feishu",
    });
    await expect(registration.qrReady).resolves.toMatchObject({ url: "https://open.feishu.cn/qr/create" });
    await expect(registration.result).resolves.toEqual({
      appId: "cli_new",
      appSecret: "secret",
      teamBrand: "feishu",
    });
    const options = register.mock.calls[0]?.[0] as RegistrationOptions;
    expect(options).toMatchObject({
      createOnly: false,
      appPreset: { name: "Assistant", desc: "OpenTag Agent: Assistant" },
      addons: {
        preset: true,
        scopes: { tenant: FEISHU_REQUIRED_TENANT_SCOPES },
        events: { items: { tenant: ["im.message.receive_v1", "im.message.recalled_v1"] } },
      },
    });
    expect(options.appId).toBeUndefined();
    expect(options.addons.scopes.user).toBeUndefined();
    expect(options.domain).toBe("accounts.feishu.cn");
  });

  /*
   * The domain is what makes a code authorizable, and it is fixed the moment the code is minted:
   * the SDK begins its device flow against this host, so a Lark tenant handed a Feishu code has
   * nothing on the page that can rescue them. The accounts host is also not the open-API host the
   * bound app talks to afterwards, which is why this asserts the literal rather than reusing
   * `feishuDomainForWorkspaceBrand`.
   */
  it("mints against the accounts domain of the brand it was asked for", async () => {
    const register = vi.fn(async (rawOptions: unknown) => {
      const options = rawOptions as RegistrationOptions;
      options.onQRCodeReady({ url: "https://accounts.larksuite.com/qr/create", expireIn: 60 });
      return { client_id: "cli_new", client_secret: "secret", user_info: { tenant_brand: "lark" } };
    });
    const registration = new DefaultFeishuRegistrationGateway(register as typeof registerApp).start({
      profile: { name: "Assistant", description: "OpenTag Agent: Assistant" },
      intent: "create",
      receiveMode: "all_message",
      brand: "lark",
    });
    await registration.qrReady;
    await expect(registration.result).resolves.toMatchObject({ teamBrand: "lark" });
    const options = register.mock.calls[0]?.[0] as RegistrationOptions;
    expect(options.domain).toBe("accounts.larksuite.com");
  });

  /*
   * The registration promise settles only after a person has scanned, signed in, approved and let the
   * app be created. A deadline short enough to time a request therefore times the human instead, and
   * fails them part-way through doing what the QR code asked. This is the regression test for that:
   * a registration nobody has finished yet is still alive well past any request-shaped budget.
   */
  it("keeps a registration alive past the device code lifetime, not merely past a request budget", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const register = vi.fn(
        (rawOptions: unknown) =>
          new Promise(() => {
            // Never settles: the reader is still in the vendor's pages, which is the normal case.
            (rawOptions as RegistrationOptions).onQRCodeReady({ url: "https://open.feishu.cn/qr", expireIn: 3600 });
          }),
      );
      const registration = new DefaultFeishuRegistrationGateway(register as typeof registerApp).start({
        profile: { name: "Assistant", description: "OpenTag Agent: Assistant" },
        intent: "create",
        receiveMode: "all_message",
        brand: "feishu",
      });
      registration.result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await registration.qrReady;

      /*
       * Past the device code's own hour, not merely past a request budget. That is the property the
       * deadline is set for: the limit that ends a registration should be the code expiring, which
       * the SDK enforces itself, rather than a number chosen to bound a request. A ten-minute
       * assertion would pass for any constant over ten minutes and would not say that.
       */
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
      await Promise.resolve();

      expect(settled).toBe(false);
      registration.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins reauthorization to the existing App and forwards cancellation", async () => {
    const register = vi.fn(
      (rawOptions: unknown) =>
        new Promise((_resolve, reject) => {
          const options = rawOptions as RegistrationOptions;
          options.onQRCodeReady({ url: "https://open.feishu.cn/qr/reauthorize", expireIn: 60 });
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { code: "abort" })),
          );
        }),
    );
    const registration = new DefaultFeishuRegistrationGateway(register as typeof registerApp).start({
      profile: { name: "Assistant", description: "OpenTag Agent: Assistant" },
      intent: "reauthorize",
      existingAppId: "cli_existing",
      receiveMode: "mention_only",
      brand: "feishu",
    });
    await registration.qrReady;
    const options = register.mock.calls[0]?.[0] as RegistrationOptions;
    expect(options.appId).toBe("cli_existing");
    expect(options.createOnly).toBeUndefined();
    expect(options.addons.scopes.tenant).toEqual(FEISHU_REQUIRED_TENANT_SCOPES);
    expect(options.addons.scopes.tenant).toContain("im:message.group_msg");
    /*
     * The cancellation is declared to the call policy, so it surfaces under the policy's own code
     * rather than the SDK's. It still has to classify as a cancelled setup rather than a failed one,
     * which is what the reader is told — so that mapping is asserted here beside it.
     */
    registration.abort();
    await expect(registration.result).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_ABORTED" });
    await expect(registration.result.catch((error) => safeFeishuSetupErrorCode(error))).resolves.toBe(
      "FEISHU_SETUP_CANCELED",
    );
  });
});
