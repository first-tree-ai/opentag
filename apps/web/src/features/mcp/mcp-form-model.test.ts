import { describe, expect, it } from "vitest";
import {
  newHeader,
  rebaseSettingsDraft,
  serverNameFromUrl,
  settingsDraft,
  suggestServerName,
} from "./mcp-form-model.js";
import { entry } from "./mcp-test-fixtures.js";

describe("serverNameFromUrl", () => {
  it.each([
    ["http://mcp.internal", "internal"],
    ["https://mcp.local", "local"],
    ["https://www.mcp.io", "io"],
    ["https://api.example.com", "api-example"],
    ["https://www.mcp", "server"],
  ])("suggests %s as %s", (url, expected) => {
    expect(serverNameFromUrl(url)).toBe(expected);
  });
});

describe("suggestServerName", () => {
  it("keeps the base name when it is available", () => {
    expect(suggestServerName("https://api.example.com", [])).toBe("api-example");
  });

  it("uses the first available numbered suffix", () => {
    expect(
      suggestServerName("https://api.example.com", [
        { name: "api-example" },
        { name: "api-example-2" },
        { name: "api-example-4" },
      ]),
    ).toBe("api-example-3");
  });
});

describe("rebaseSettingsDraft", () => {
  it.each(["", "in-progress"])("preserves an added unnamed header with value %s during a live update", (value) => {
    const previous = entry({ overridden: { ...entry().overridden, extraHeaders: true } });
    const draft = settingsDraft(previous);
    draft.headers.push({ ...newHeader(), value });
    const next = entry({ ...previous, updatedAt: "2026-10-10T08:00:00.000Z" });
    const rebased = rebaseSettingsDraft(previous, draft, next);
    expect(rebased.headers).toEqual(draft.headers);
    expect(rebased.headerMode).toBe("custom");
  });

  it("keeps an explicit switch from empty headers to custom headers during a live update", () => {
    const previous = entry({
      effective: { ...entry().effective, extraHeaders: {} },
      overridden: { ...entry().overridden, extraHeaders: true },
    });
    const draft = { ...settingsDraft(previous), headerMode: "custom" as const };
    expect(rebaseSettingsDraft(previous, draft, entry({ ...previous, enabled: false })).headerMode).toBe("custom");
  });

  it("follows confirmed header changes when the header draft is untouched", () => {
    const previous = entry();
    const next = entry({
      effective: { ...previous.effective, extraHeaders: { "x-new": "saved" } },
      overridden: { ...previous.overridden, extraHeaders: true },
    });
    const rebased = rebaseSettingsDraft(previous, settingsDraft(previous), next);
    expect(rebased.headerMode).toBe("custom");
    expect(rebased.headers.map(({ name, value }) => ({ name, value }))).toEqual([{ name: "x-new", value: "saved" }]);
  });
});
