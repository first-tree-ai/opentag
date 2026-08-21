import { describe, expect, it, vi } from "vitest";
import {
  createImProviderAdapterResolver,
  ProviderAdapterResolutionError,
} from "../services/im-bindings/provider-adapter-resolver.js";

const imBindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";

function bindings() {
  return {
    getSlackConnectionMaterial: vi.fn(),
    getFeishuConnectionMaterial: vi.fn(),
  };
}

describe("IM provider adapter resolver", () => {
  it("prefers matching Slack material without reading Feishu credentials", async () => {
    const imBindings = bindings();
    imBindings.getSlackConnectionMaterial.mockResolvedValue({
      imBindingId,
      generation: 3,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
      botAccessToken: "xoxb-current",
      signingSecret: "signing-secret",
      grantedScopes: ["chat:write"],
    });
    const resolve = createImProviderAdapterResolver({
      imBindings: imBindings as never,
      slackApi: {} as never,
    });

    const adapter = await resolve(imBindingId, 3);
    expect(adapter.provider).toBe("slack");
    expect(imBindings.getFeishuConnectionMaterial).not.toHaveBeenCalled();
  });

  it("fails closed for a stale Slack generation without constructing another adapter", async () => {
    const imBindings = bindings();
    imBindings.getSlackConnectionMaterial.mockResolvedValue({
      imBindingId,
      generation: 4,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
      botAccessToken: "xoxb-sensitive",
      signingSecret: "signing-sensitive",
      grantedScopes: [],
    });
    const createFeishuAdapter = vi.fn();
    const resolve = createImProviderAdapterResolver({
      imBindings: imBindings as never,
      slackApi: {} as never,
      createFeishuAdapter,
    });

    const failure = await resolve(imBindingId, 3).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderAdapterResolutionError);
    expect(failure).toMatchObject({ name: "ProviderAdapterResolutionError", code: "IM_BINDING_GENERATION_STALE" });
    expect(String(failure)).not.toContain("sensitive");
    expect(createFeishuAdapter).not.toHaveBeenCalled();
    expect(imBindings.getFeishuConnectionMaterial).not.toHaveBeenCalled();
  });

  it("falls back to matching Feishu material and passes only that binding's material", async () => {
    const imBindings = bindings();
    imBindings.getSlackConnectionMaterial.mockResolvedValue(undefined);
    imBindings.getFeishuConnectionMaterial.mockResolvedValue({
      imBindingId,
      generation: 7,
      appId: "cli_a1",
      appSecret: "feishu-sensitive",
      teamId: "tenant-1",
      botOpenId: "ou_1",
      teamBrand: "feishu",
      grantedScopes: ["im:message"],
    });
    const adapter = { provider: "feishu" };
    const createFeishuAdapter = vi.fn(() => adapter as never);
    const resolve = createImProviderAdapterResolver({
      imBindings: imBindings as never,
      slackApi: {} as never,
      createFeishuAdapter,
    });

    await expect(resolve(imBindingId, 7)).resolves.toBe(adapter);
    expect(createFeishuAdapter).toHaveBeenCalledWith({
      appId: "cli_a1",
      appSecret: "feishu-sensitive",
      teamId: "tenant-1",
      teamBrand: "feishu",
    });
  });

  it("fails closed for stale or unavailable Feishu material without exposing credentials", async () => {
    const imBindings = bindings();
    imBindings.getSlackConnectionMaterial.mockResolvedValue(undefined);
    imBindings.getFeishuConnectionMaterial.mockResolvedValue({
      imBindingId,
      generation: 9,
      appId: "cli_a1",
      appSecret: "feishu-sensitive",
      teamId: null,
      botOpenId: "ou_1",
      teamBrand: null,
      grantedScopes: [],
    });
    const createFeishuAdapter = vi.fn();
    const resolve = createImProviderAdapterResolver({
      imBindings: imBindings as never,
      slackApi: {} as never,
      createFeishuAdapter,
    });

    const stale = await resolve(imBindingId, 8).catch((error: unknown) => error);
    expect(stale).toMatchObject({
      name: "ProviderAdapterResolutionError",
      code: "IM_BINDING_GENERATION_STALE",
    });
    expect(String(stale)).not.toContain("feishu-sensitive");
    expect(createFeishuAdapter).not.toHaveBeenCalled();

    imBindings.getFeishuConnectionMaterial.mockResolvedValue(undefined);
    const unavailable = await resolve(imBindingId, 8).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({
      name: "ProviderAdapterResolutionError",
      code: "IM_BINDING_ADAPTER_UNAVAILABLE",
    });
  });
});
