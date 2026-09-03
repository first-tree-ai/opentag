/**
 * The readiness rows primitive: a fixed set of rows that show exactly the state and copy they are
 * handed, keep their DOM identity across rerenders, and keep their slots mounted even when empty.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type CheckRow,
  type CheckState,
  ReadinessList,
  type ReadinessRows,
  type ReadinessStatus,
} from "./readiness-list.js";

const here = dirname(fileURLToPath(import.meta.url));

const COMPUTER = "computer";
const RUNTIME = "runtime";
const FEISHU = "im-cli:feishu";
const SLACK = "im-cli:slack";
const ORDER = [COMPUTER, RUNTIME, FEISHU, SLACK] as const;

const CHECK_STATES: readonly CheckState[] = ["pending", "passed", "failed", "blocked"];
const READINESS_STATUSES: readonly ReadinessStatus[] = [
  "waiting",
  "checking",
  "install-required",
  "ready",
  "needs-attention",
  "stale",
];

const LONG_EN_DETAIL =
  "The runtime answered, but the version it reports is older than this workspace expects, so the " +
  "check needs a repair command before onboarding can continue past this step.";
const ZH_TITLE = "这是一段很长很长的中文行标题，用来确认换行和滚动都不会改变这一行的结构";
const ZH_DETAIL =
  "第一行：安装命令已经打印在上一步。\n第二行：安装完成之后重新运行检查。\n第三行：这是一段很长的中文诊断文字，用来确认诊断槽位保持固定。";

function checkRow(overrides: Partial<CheckRow> = {}): CheckRow {
  return {
    state: "pending",
    status: "waiting",
    label: "Computer",
    statusLabel: "Waiting",
    detail: "",
    detailLabel: "Computer diagnostics",
    ...overrides,
  };
}

/** Four fixed rows whose detail is blank by default, so "mounted even when empty" is the norm. */
function readinessRows(
  computer: Partial<CheckRow> = {},
  runtime: Partial<CheckRow> = {},
  feishu: Partial<CheckRow> = {},
  slack: Partial<CheckRow> = {},
): ReadinessRows {
  return {
    computer: checkRow(computer),
    runtime: checkRow(runtime),
    feishu: checkRow(feishu),
    slack: checkRow(slack),
  };
}

function row(component: string): HTMLElement {
  const element = document.querySelector(`[data-ui="readiness-list"] [data-component="${component}"]`);
  if (!element) throw new Error(`Missing readiness row for ${component}`);
  return element as HTMLElement;
}

describe("readiness list", () => {
  it("renders one labelled semantic list with the four rows in the fixed order", () => {
    render(<ReadinessList label="Readiness check" rows={readinessRows()} />);

    const list = screen.getByRole("list", { name: "Readiness check" });
    expect(list.tagName).toBe("OL");
    expect(list.getAttribute("data-ui")).toBe("readiness-list");

    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.getAttribute("data-component"))).toEqual([...ORDER]);
    items.forEach((item, index) => {
      const marker = item.querySelector(".otv2-readiness__marker");
      expect(marker?.getAttribute("aria-hidden")).toBe("true");
      expect(marker?.textContent).toBe(String(index + 1));
    });
  });

  it("passes every state and readiness status through as row attributes", () => {
    const view = render(<ReadinessList label="Readiness" rows={readinessRows()} />);
    let previousRows: HTMLElement[] = [];
    for (const state of CHECK_STATES) {
      for (const status of READINESS_STATUSES) {
        const rows = readinessRows({ state, status }, { state, status }, { state, status }, { state, status });
        view.rerender(<ReadinessList label="Readiness" rows={rows} />);
        const items = [...ORDER].map((component) => row(component));
        expect(items.map((item) => item.getAttribute("data-state"))).toEqual(Array(4).fill(state));
        expect(items.map((item) => item.getAttribute("data-status"))).toEqual(Array(4).fill(status));
        items.forEach((item, index) => {
          expect(item.querySelector(".otv2-readiness__marker")?.textContent).toBe(String(index + 1));
        });
        if (previousRows.length > 0) {
          items.forEach((item, index) => {
            expect(item).toBe(previousRows[index]);
          });
        }
        previousRows = items;
      }
    }
  });

  it("shows exactly the copy the caller supplies, including Codex and Claude Code labels", () => {
    render(
      <ReadinessList
        label="Readiness"
        rows={readinessRows(
          { label: "Codex computer", statusLabel: "Ready", detail: "Connected", detailLabel: "Computer diagnostics" },
          {
            label: "Claude Code runtime",
            statusLabel: "Checking",
            detail: "Contacting the runtime",
            detailLabel: "Runtime diagnostics",
          },
          { label: "Feishu CLI", statusLabel: "Install required", detail: "", detailLabel: "Feishu diagnostics" },
          { label: "Slack CLI", statusLabel: "Needs attention", detail: "Reconnect", detailLabel: "Slack diagnostics" },
        )}
      />,
    );

    expect(within(row(COMPUTER)).getByText("Codex computer")).toBeTruthy();
    expect(within(row(COMPUTER)).getByText("Ready")).toBeTruthy();
    expect(within(row(RUNTIME)).getByText("Claude Code runtime")).toBeTruthy();
    expect(within(row(RUNTIME)).getByText("Checking")).toBeTruthy();
    expect(within(row(FEISHU)).getByText("Feishu CLI")).toBeTruthy();
    expect(within(row(FEISHU)).getByText("Install required")).toBeTruthy();
    expect(within(row(SLACK)).getByText("Slack CLI")).toBeTruthy();
    expect(within(row(SLACK)).getByText("Needs attention")).toBeTruthy();
  });

  it("keeps product and provider naming out of the primitive itself", () => {
    const source = readFileSync(resolve(here, "readiness-list.tsx"), "utf8");
    expect(source).not.toMatch(/Codex|Claude/i);
    expect(source).not.toMatch(/lark/i);
  });

  it("always mounts the title and detail slots, even when the detail copy is blank", () => {
    const labels = ["Codex computer", "Claude Code runtime", "Feishu CLI", "Slack CLI"];
    const statusLabels = ["Ready", "Checking", "Install required", "Needs attention"];
    const detailLabels = ["Computer diagnostics", "Runtime diagnostics", "Feishu diagnostics", "Slack diagnostics"];
    render(
      <ReadinessList
        label="Readiness"
        rows={readinessRows(
          { label: labels[0], statusLabel: statusLabels[0], detail: "", detailLabel: detailLabels[0] },
          { label: labels[1], statusLabel: statusLabels[1], detail: "", detailLabel: detailLabels[1] },
          { label: labels[2], statusLabel: statusLabels[2], detail: "", detailLabel: detailLabels[2] },
          { label: labels[3], statusLabel: statusLabels[3], detail: "", detailLabel: detailLabels[3] },
        )}
      />,
    );

    [...ORDER].forEach((component, index) => {
      const item = row(component);
      const title = item.querySelector('[data-ui="readiness-title"]');
      const detail = item.querySelector('[data-ui="readiness-detail"]');

      expect(title).not.toBeNull();
      expect(detail).not.toBeNull();
      expect(title?.textContent).toContain(labels[index]);
      expect(title?.textContent).toContain(statusLabels[index]);
      expect(detail?.textContent).toBe("");
      expect(detail?.getAttribute("aria-label")).toBe(detailLabels[index]);
      // The slots are the scroll regions, so both stay keyboard-reachable...
      expect((title as HTMLElement).tabIndex).toBe(0);
      expect((detail as HTMLElement).tabIndex).toBe(0);
    });
  });

  it("rerenders blank, long English, and long Chinese copy into the same row and slot elements", () => {
    const view = render(<ReadinessList label="Readiness" rows={readinessRows()} />);
    const firstRows = [...ORDER].map((component) => row(component));
    const firstDetails = firstRows.map((item) => item.querySelector('[data-ui="readiness-detail"]'));

    view.rerender(
      <ReadinessList
        label="Readiness"
        rows={readinessRows(
          {
            state: "passed",
            status: "ready",
            label: "Codex computer",
            statusLabel: "Ready",
            detail: LONG_EN_DETAIL,
            detailLabel: "Computer diagnostics",
          },
          {
            state: "failed",
            status: "needs-attention",
            label: "Claude Code runtime",
            statusLabel: "Needs attention",
            detail: "Install the supported runtime version, then check again.",
            detailLabel: "Runtime diagnostics",
          },
          {
            state: "pending",
            status: "install-required",
            label: "Feishu CLI",
            statusLabel: "Install required",
            detail: "Run the printed command and check again.",
            detailLabel: "Feishu diagnostics",
          },
          {
            state: "blocked",
            status: "stale",
            label: "Slack CLI",
            statusLabel: "Stale",
            detail: "The install link expired; ask for a fresh one.",
            detailLabel: "Slack diagnostics",
          },
        )}
      />,
    );

    const enRows = [...ORDER].map((component) => row(component));
    enRows.forEach((item, index) => {
      expect(item).toBe(firstRows[index]);
    });
    expect(within(row(COMPUTER)).getByText(LONG_EN_DETAIL)).toBeTruthy();

    view.rerender(
      <ReadinessList
        label="就绪检查"
        rows={readinessRows(
          {
            state: "passed",
            status: "needs-attention",
            label: "电脑",
            statusLabel: "需要关注",
            detail: ZH_DETAIL,
            detailLabel: "电脑诊断",
          },
          {
            state: "passed",
            status: "ready",
            label: "运行时",
            statusLabel: "就绪",
            detail: "",
            detailLabel: "运行时诊断",
          },
          {
            state: "failed",
            status: "install-required",
            label: ZH_TITLE,
            statusLabel: "需要安装",
            detail: "",
            detailLabel: "命令行诊断",
          },
          {
            state: "blocked",
            status: "stale",
            label: "Slack 命令行",
            statusLabel: "已过期",
            detail: "",
            detailLabel: "Slack 诊断",
          },
        )}
      />,
    );

    const zhRows = [...ORDER].map((component) => row(component));
    zhRows.forEach((item, index) => {
      expect(item).toBe(firstRows[index]);
      expect(item.querySelector('[data-ui="readiness-detail"]')).toBe(firstDetails[index]);
    });
    expect(screen.getByRole("list", { name: "就绪检查" })).toBeTruthy();
    expect(within(row(FEISHU)).getByText(ZH_TITLE)).toBeTruthy();
    const zhDetail = row(COMPUTER).querySelector('[data-ui="readiness-detail"]');
    expect(zhDetail?.textContent).toContain("第一行");
    expect(zhDetail?.textContent).toContain("\n");
    expect(row(SLACK).querySelector('[data-ui="readiness-detail"]')?.textContent).toBe("");
    zhRows.forEach((item, index) => {
      expect(item.querySelector(".otv2-readiness__marker")?.textContent).toBe(String(index + 1));
    });
  });

  it("keeps a passed row passed when a needs-attention warning arrives", () => {
    const view = render(
      <ReadinessList
        label="Readiness"
        rows={readinessRows(
          {},
          {
            state: "passed",
            status: "ready",
            label: "Claude Code runtime",
            statusLabel: "Ready",
            detail: "Up to date",
            detailLabel: "Runtime diagnostics",
          },
        )}
      />,
    );
    const runtimeRow = row(RUNTIME);
    expect(runtimeRow.getAttribute("data-state")).toBe("passed");
    expect(runtimeRow.getAttribute("data-status")).toBe("ready");

    view.rerender(
      <ReadinessList
        label="Readiness"
        rows={readinessRows(
          {},
          {
            state: "passed",
            status: "needs-attention",
            label: "Claude Code runtime",
            statusLabel: "Needs attention",
            detail: "A newer runtime version is recommended.",
            detailLabel: "Runtime diagnostics",
          },
        )}
      />,
    );

    expect(row(RUNTIME)).toBe(runtimeRow);
    expect(row(RUNTIME).getAttribute("data-state")).toBe("passed");
    expect(row(RUNTIME).getAttribute("data-status")).toBe("needs-attention");
    expect(within(row(RUNTIME)).getByText("Needs attention")).toBeTruthy();
    expect(within(row(RUNTIME)).getByText("A newer runtime version is recommended.")).toBeTruthy();
  });

  it("renders HTML-looking diagnostics as text, never as markup", () => {
    const detail = '<b>bold</b> install <script>alert("install")</script> me';
    render(
      <ReadinessList
        label="Readiness"
        rows={readinessRows(
          {},
          {},
          { label: "Feishu CLI", statusLabel: "Install required", detail, detailLabel: "Feishu diagnostics" },
          {},
        )}
      />,
    );

    const feishuDetail = row(FEISHU).querySelector('[data-ui="readiness-detail"]');
    expect(feishuDetail?.textContent).toBe(detail);
    expect(document.querySelectorAll("b, script")).toHaveLength(0);
  });
});
