import { describe, expect, it, vi } from "vitest";
import { mcpTitle } from "./mcp-title.js";

const locale = vi.hoisted(() => ({ value: "en" }));
vi.mock("../../i18n/locale.js", () => ({ getLocale: () => locale.value }));
vi.mock("@opentag/mcp-presets", () => ({
  MCP_CATALOG_ENTRIES: [
    {
      id: "sample",
      name: "sample",
      installable: true,
      url: "https://sample.test/mcp",
      title: { en: "Sample", zh: "示例" },
    },
  ],
}));

describe("connector display titles", () => {
  it("shows the catalog title for an installation's base name and numeric suffix", () => {
    locale.value = "en";
    for (const name of ["sample", "sample-2", "sample-30"]) {
      expect(
        mcpTitle({
          name,
          effective: {
            url: "https://sample.test/mcp",
            authHeader: "authorization",
            authScheme: "Bearer",
            extraHeaders: {},
          },
        }),
      ).toBe("Sample");
    }
    locale.value = "zh";
    expect(
      mcpTitle({
        name: "sample-2",
        effective: {
          url: "https://sample.test/mcp",
          authHeader: "authorization",
          authScheme: "Bearer",
          extraHeaders: {},
        },
      }),
    ).toBe("示例");
  });

  it.each(["team-2", "sample-production", "sample-1", "sample-02"])("preserves custom name %s", (name) => {
    expect(
      mcpTitle({
        name,
        effective: {
          url: "https://sample.test/mcp",
          authHeader: "authorization",
          authScheme: "Bearer",
          extraHeaders: {},
        },
      }),
    ).toBe(name);
  });

  it("does not hide a suffix at a custom endpoint", () => {
    expect(
      mcpTitle({
        name: "sample-2",
        effective: {
          url: "https://custom.test/mcp",
          authHeader: "authorization",
          authScheme: "Bearer",
          extraHeaders: {},
        },
      }),
    ).toBe("sample-2");
  });
});
