import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app.js";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { agentId, computerId, installApi, resetWebAppState } from "./support/app-fixtures.js";

const translations = [
  {
    locale: "en" as const,
    heading: "Computer",
    runtime: "Runtime",
    offline: "Offline",
    restore: "Restore connection",
    repair: "Repair connection",
    start: "Get connection help",
    copy: "Copy instructions",
    close: "Close Connection help",
    back: "Back to Reviewer settings",
  },
  {
    locale: "zh" as const,
    heading: "电脑",
    runtime: "运行环境",
    offline: "离线",
    restore: "恢复连接",
    repair: "修复连接",
    start: "查看连接帮助",
    copy: "复制指令",
    close: "关闭 连接帮助",
    back: "返回 Reviewer 设置",
  },
];

describe("Computer localization", () => {
  beforeEach(resetWebAppState);
  afterEach(() => overwriteGetLocale(() => "en"));

  it.each(translations)("keeps the complete recovery and return path localized in $locale", async (copy) => {
    overwriteGetLocale(() => copy.locale);
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: copy.heading, level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: copy.runtime })).toBeNull();
    expect(screen.getByText(copy.offline)).toBeTruthy();
    const restore = screen.getByRole("link", { name: copy.restore });
    expect(restore.getAttribute("href")).toContain(`computerId=${computerId}`);
    fireEvent.click(restore);
    const help = await screen.findByRole("button", { name: copy.start });
    expect(screen.queryByRole("button", { name: copy.repair })).toBeNull();
    fireEvent.click(help);
    expect(await screen.findByRole("button", { name: copy.copy })).toBeTruthy();
    expect(screen.getByRole("region", { name: copy.restore }).textContent).toContain("opentag doctor --json");
    if (copy.locale === "zh") {
      expect(screen.queryByRole("heading", { name: "运行环境" })).toBeNull();
      expect(screen.getByRole("main").textContent).not.toMatch(/计算机|账号|\bComputer\b|运行时/);
    }
    fireEvent.click(screen.getByRole("button", { name: copy.close }));
    fireEvent.click(await screen.findByRole("link", { name: copy.back }));
    expect(await screen.findByRole("link", { name: copy.restore })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: copy.runtime })).toBeNull();
    expect(screen.queryByRole("button", { name: copy.repair })).toBeNull();
  });
});
