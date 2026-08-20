import type { registerApp } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";

import { DefaultFeishuRegistrationGateway, feishuMessageScopes } from "../services/integrations/feishu/registration.js";

interface RegistrationOptions {
  appId?: string;
  createOnly?: boolean;
  signal: AbortSignal;
  appPreset: { name: string; desc: string };
  addons: { preset: boolean; scopes: { tenant: string[] }; events: { items: { tenant: string[] } } };
  onQRCodeReady(input: { url: string; expireIn: number }): void;
}

describe("Feishu registration", () => {
  it("requests only the message, resource, and reaction capabilities used by OpenTag", () => {
    expect(feishuMessageScopes("mention_only")).toEqual([
      "im:message:send_as_bot",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:readonly",
      "contact:user.id:readonly",
      "im:resource",
      "im:message.reactions:write_only",
    ]);
    expect(feishuMessageScopes("all_message")).toEqual([
      ...feishuMessageScopes("mention_only"),
      "im:message.group_msg",
    ]);
  });

  it("prefills a create-only Personal Agent consent flow", async () => {
    const register = vi.fn(async (rawOptions: unknown) => {
      const options = rawOptions as RegistrationOptions;
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr/create", expireIn: 60 });
      return { client_id: "cli_new", client_secret: "secret", user_info: { tenant_brand: "feishu" } };
    });
    const registration = new DefaultFeishuRegistrationGateway(register as typeof registerApp).start({
      profile: { name: "Assistant", description: "OpenTag Agent: Assistant" },
      intent: "create",
      receiveMode: "all_message",
    });
    await expect(registration.qrReady).resolves.toMatchObject({ url: "https://open.feishu.cn/qr/create" });
    await expect(registration.result).resolves.toEqual({
      appId: "cli_new",
      appSecret: "secret",
      teamBrand: "feishu",
      requestedScopes: feishuMessageScopes("all_message"),
    });
    const options = register.mock.calls[0]?.[0] as RegistrationOptions;
    expect(options).toMatchObject({
      createOnly: true,
      appPreset: { name: "Assistant", desc: "OpenTag Agent: Assistant" },
      addons: {
        preset: true,
        scopes: { tenant: feishuMessageScopes("all_message") },
        events: { items: { tenant: ["im.message.receive_v1", "im.message.recalled_v1"] } },
      },
    });
    expect(options.appId).toBeUndefined();
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
    });
    await registration.qrReady;
    const options = register.mock.calls[0]?.[0] as RegistrationOptions;
    expect(options.appId).toBe("cli_existing");
    expect(options.createOnly).toBeUndefined();
    expect(options.addons.scopes.tenant).toEqual(feishuMessageScopes("mention_only"));
    registration.abort();
    await expect(registration.result).rejects.toMatchObject({ code: "abort" });
  });
});
