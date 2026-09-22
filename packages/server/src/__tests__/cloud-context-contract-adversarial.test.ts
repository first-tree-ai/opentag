import { describe, expect, it } from "vitest";
import { RouterCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";

function catalog(data: unknown[]) {
  return new RouterCloudModelCatalog({
    upstreamBaseUrl: "https://router.invalid/v1",
    masterKey: "fixture-only",
    fetchImpl: async () => Response.json({ object: "list", data }),
  });
}

describe("Cloud model capability admission", () => {
  it("offers only verified models and selects the first eligible default", async () => {
    const models = catalog([
      { id: "missing" },
      { id: "too-small", context_window: 63_999, max_output_tokens: 8_192 },
      { id: "valid-standard", context_window: 64_000, max_output_tokens: 4_096 },
      { id: "valid-extended", context_window: 258_000, max_output_tokens: 8_192 },
    ]);
    await expect(models.list()).resolves.toEqual({
      available: true,
      defaultModel: "valid-standard",
      models: ["valid-standard", "valid-extended"],
    });
    await expect(models.isModelAllowed("missing")).resolves.toBe(false);
    await expect(models.isModelAllowed("too-small")).resolves.toBe(false);
  });

  it.each([
    { id: "missing" },
    { id: "small", context_window: 63_999, max_output_tokens: 8_192 },
    { id: "fractional", context_window: 64_000.5, max_output_tokens: 8_192 },
    { id: "unknown-output", context_window: 258_000 },
    { id: "invalid-output", context_window: 258_000, max_output_tokens: 0 },
  ])("does not fabricate a default for $id", async (entry) => {
    const models = catalog([entry]);
    await expect(models.list()).resolves.toEqual({ available: false, defaultModel: null, models: [] });
    await expect(models.defaultModel()).resolves.toBeUndefined();
  });
});
