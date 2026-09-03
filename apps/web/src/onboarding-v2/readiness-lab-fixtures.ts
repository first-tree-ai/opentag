/**
 * Review fixtures for the readiness lab: every row model is explicit, and every string is static
 * copy written for the lab only. The lab never passes these rows through a setup adapter — it
 * renders them straight into the presentational `ReadinessList`.
 */

import { messagingProviderLabel } from "../im/provider-label.js";
import type { CheckRow, CheckState, ReadinessRows, ReadinessStatus } from "./readiness-list.js";

export const READINESS_SCENARIOS = [
  "readiness-waiting",
  "readiness-checking",
  "readiness-install-required",
  "readiness-ready",
  "readiness-needs-attention",
  "readiness-stale",
  "readiness-blank",
  "readiness-long-en",
  "readiness-long-zh",
  "readiness-mixed",
  "readiness-warning",
] as const;

export type ReadinessScenario = (typeof READINESS_SCENARIOS)[number];

export function isReadinessScenario(scenario: string): scenario is ReadinessScenario {
  return (READINESS_SCENARIOS as readonly string[]).includes(scenario);
}

export const READINESS_SCENARIO_LABELS: Readonly<Record<ReadinessScenario, string>> = {
  "readiness-waiting": "Checklist: waiting",
  "readiness-checking": "Checklist: checking",
  "readiness-install-required": "Checklist: install required",
  "readiness-ready": "Checklist: ready",
  "readiness-needs-attention": "Checklist: needs attention",
  "readiness-stale": "Checklist: stale",
  "readiness-blank": "Blank details",
  "readiness-long-en": "Long English",
  "readiness-long-zh": "中文长文案",
  "readiness-mixed": "Mixed states",
  "readiness-warning": "Passed with warning",
};

export const PREVIEW_RUNTIMES = ["codex", "claude-code", "long"] as const;
export type PreviewRuntime = (typeof PREVIEW_RUNTIMES)[number];

export const CODE_RUNTIME_LABEL = "Codex";
export const CLAUDE_CODE_RUNTIME_LABEL = "Claude Code";
export const LONG_RUNTIME_LABEL_EN =
  "Codex with an unusually long custom runtime display name for this review workspace";
export const LONG_RUNTIME_LABEL_ZH = "Codex——自定义运行时显示名称被故意设置得很长，用于预览窄屏换行与滚动（仅评审）";

/** The runtime row label is always the caller's supplied runtime copy, never inferred here. */
export function runtimeLabelFor(runtime: PreviewRuntime, scenario: ReadinessScenario): string {
  if (runtime === "codex") return CODE_RUNTIME_LABEL;
  if (runtime === "claude-code") return CLAUDE_CODE_RUNTIME_LABEL;
  return scenario === "readiness-long-zh" ? LONG_RUNTIME_LABEL_ZH : LONG_RUNTIME_LABEL_EN;
}

function row(model: {
  readonly label: string;
  readonly detailLabel: string;
  readonly state: CheckState;
  readonly status: ReadinessStatus;
  readonly statusLabel: string;
  readonly detail: string;
}): CheckRow {
  return { ...model };
}

function computerRow(detail: string, state: CheckState, status: ReadinessStatus, statusLabel: string): CheckRow {
  return row({
    label: "Computer",
    detailLabel: "Computer diagnostics",
    detail,
    state,
    status,
    statusLabel,
  });
}

function runtimeRow(
  runtimeLabel: string,
  state: CheckState,
  status: ReadinessStatus,
  statusLabel: string,
  detail: string,
): CheckRow {
  return row({ label: runtimeLabel, detailLabel: "Runtime diagnostics", detail, state, status, statusLabel });
}

function feishuRow(state: CheckState, status: ReadinessStatus, statusLabel: string, detail: string): CheckRow {
  return row({
    label: `${messagingProviderLabel("feishu")} CLI`,
    detailLabel: `${messagingProviderLabel("feishu")} CLI diagnostics`,
    detail,
    state,
    status,
    statusLabel,
  });
}

function slackRow(state: CheckState, status: ReadinessStatus, statusLabel: string, detail: string): CheckRow {
  return row({
    label: `${messagingProviderLabel("slack")} CLI`,
    detailLabel: `${messagingProviderLabel("slack")} CLI diagnostics`,
    detail,
    state,
    status,
    statusLabel,
  });
}

function waitingRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Waiting for the computer to finish connecting.", "pending", "waiting", "Waiting"),
    runtime: runtimeRow(
      runtimeLabel,
      "blocked",
      "waiting",
      "Waiting for Computer",
      "Runtime checks wait for the computer to connect first.",
    ),
    feishu: feishuRow(
      "blocked",
      "waiting",
      "Waiting for Computer",
      `The ${messagingProviderLabel("feishu")} CLI check starts once the computer is connected.`,
    ),
    slack: slackRow(
      "blocked",
      "waiting",
      "Waiting for Computer",
      `The ${messagingProviderLabel("slack")} check waits behind the computer check.`,
    ),
  };
}

function checkingRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Checking the current Computer connection.", "pending", "checking", "Checking"),
    runtime: runtimeRow(
      runtimeLabel,
      "pending",
      "checking",
      "Checking",
      "Checking the installed runtime version and its sign-in state.",
    ),
    feishu: feishuRow(
      "pending",
      "checking",
      "Checking",
      `Checking the ${messagingProviderLabel("feishu")} CLI executable and compatible version.`,
    ),
    slack: slackRow(
      "pending",
      "checking",
      "Checking",
      `Checking the ${messagingProviderLabel("slack")} CLI executable and compatible version.`,
    ),
  };
}

function installRequiredRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Connected to Review Mac.", "passed", "ready", "Ready"),
    runtime: runtimeRow(
      runtimeLabel,
      "failed",
      "install-required",
      "Install required",
      "The selected Runtime CLI is missing. Install it manually, then check again; OpenTag does not install Runtime CLIs.",
    ),
    feishu: feishuRow(
      "pending",
      "install-required",
      "Install required",
      `The foreground preparation command must install the ${messagingProviderLabel("feishu")} CLI artifact, then the daemon can check it again.`,
    ),
    slack: slackRow(
      "pending",
      "install-required",
      "Install required",
      `The foreground preparation command must install the ${messagingProviderLabel("slack")} CLI artifact, then the daemon can check it again.`,
    ),
  };
}

function readyRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Connected to Review Mac.", "passed", "ready", "Computer ready"),
    runtime: runtimeRow(
      runtimeLabel,
      "passed",
      "ready",
      `${runtimeLabel} ready`,
      "The operator-supplied CLI, required capabilities, and Runtime sign-in check passed.",
    ),
    feishu: feishuRow(
      "passed",
      "ready",
      `${messagingProviderLabel("feishu")} CLI ready`,
      `Compatible ${messagingProviderLabel("feishu")} CLI artifact verified locally.`,
    ),
    slack: slackRow(
      "passed",
      "ready",
      `${messagingProviderLabel("slack")} CLI ready`,
      `Compatible ${messagingProviderLabel("slack")} CLI artifact verified locally.`,
    ),
  };
}

function needsAttentionRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Connected to Review Mac.", "passed", "ready", "Ready"),
    runtime: runtimeRow(
      runtimeLabel,
      "failed",
      "needs-attention",
      "Needs attention",
      "version_incompatible: the selected Runtime CLI lacks a required capability. Update it manually, then recheck.",
    ),
    feishu: feishuRow(
      "failed",
      "needs-attention",
      "Needs attention",
      `integrity_failed: the selected ${messagingProviderLabel("feishu")} CLI artifact did not pass verification. Use the reported idempotent repair action.`,
    ),
    slack: slackRow(
      "failed",
      "needs-attention",
      "Needs attention",
      `executable_unavailable: the ${messagingProviderLabel("slack")} CLI executable cannot be launched. Repair the artifact and inspect it again.`,
    ),
  };
}

function staleRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow(
      "The current connection report expired. Refresh to obtain fresh evidence for this exact Computer.",
      "blocked",
      "stale",
      "Stale",
    ),
    runtime: runtimeRow(
      runtimeLabel,
      "blocked",
      "stale",
      "Stale",
      "The Runtime report expired. The previous ready result is no longer current; request a fresh check.",
    ),
    feishu: feishuRow(
      "blocked",
      "stale",
      "Stale",
      `The ${messagingProviderLabel("feishu")} CLI artifact report expired. Request a fresh local inspection.`,
    ),
    slack: slackRow(
      "blocked",
      "stale",
      "Stale",
      `The ${messagingProviderLabel("slack")} CLI artifact report expired. Request a fresh local inspection.`,
    ),
  };
}

function blankRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("", "pending", "waiting", "Waiting"),
    runtime: runtimeRow(runtimeLabel, "pending", "checking", "Checking", ""),
    feishu: feishuRow("pending", "install-required", "Install required", ""),
    slack: slackRow("pending", "waiting", "Waiting", ""),
  };
}

function longEnRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow(
      "Review fixture: the exact bound Computer is online on its current connection. The remaining rows are independent observations; connection alone does not prove any CLI ready.",
      "passed",
      "ready",
      "Ready",
    ),
    runtime: runtimeRow(
      runtimeLabel,
      "pending",
      "checking",
      "Checking",
      "Review fixture: a real checking observation is in progress for the selected operator-supplied Runtime CLI. Its executable, compatible version, required capabilities, and Runtime sign-in are checked independently of messaging setup.\nWait for a fresh reading. If the check reports a missing or incompatible CLI, install or update that Runtime manually and request another check. OpenTag does not install Runtime CLIs.\nFictional diagnostic identifier for wrapping: example_runtime_diagnostic_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz\nThis is static review copy, not a live progress report or an executable repair instruction.",
    ),
    feishu: feishuRow(
      "failed",
      "install-required",
      "Install required",
      `Review fixture: the ${messagingProviderLabel("feishu")} CLI artifact requires installation. This does not mean installation is currently running. Use the foreground command's reported idempotent repair action, then inspect the artifact again.\nVerification command: opentag provider-cli inspect --provider feishu\nFictional diagnostic identifier: example_artifact_diagnostic_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789\nA local artifact check does not select or connect a messaging integration.`,
    ),
    slack: slackRow(
      "pending",
      "waiting",
      "Waiting",
      `Review fixture: no ${messagingProviderLabel("slack")} CLI artifact observation has arrived from this Computer connection. Absence of a report is waiting, not checking. Wait for the daemon's fresh local artifact inspection or request a recheck; do not reuse a consumed Computer connect code.\nVerification command: opentag provider-cli inspect --provider slack`,
    ),
  };
}

const ZH_COMPUTER_DETAIL =
  "评审示例：当前智能体明确绑定的 Review Mac 已在线。Computer 连接与各个 CLI 的本机检查是独立事实；仅连接成功不能代表其余项目已就绪。";
const ZH_RUNTIME_DETAIL =
  "评审示例：version_incompatible，第一步所选 Runtime CLI 不具备所需能力，因此本项尚未就绪。请由操作者手动安装或更新所选 Runtime，再重新检查。OpenTag 不会自动安装 Runtime CLI。\n本项检查操作者预装的确切可执行文件、兼容版本、所需能力及 Runtime 登录状态。修复后需要收到新的检查报告，不能继续沿用先前的就绪结果。\n用于测试换行的虚构诊断编号：example_runtime_diagnostic_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz\n这些文字仅用于评审固定槽位和滚动，不是实时安装进度。";
function zhFeishuDetail(): string {
  return `评审示例：${messagingProviderLabel("feishu")} CLI 本机文件需要安装，这不等于正在安装。使用前台准备命令返回的幂等修复动作，完成后重新检查本机文件。\n验证命令：opentag provider-cli inspect --provider feishu\n用于窄屏换行的虚构诊断编号：example_artifact_diagnostic_abcdefghijklmnopqrstuvwxyz_0123456789_abcdefghijklmnopqrstuvwxyz_0123456789\n本机 CLI 文件的准备不选择或连接消息应用。`;
}

function zhSlackDetail(): string {
  return `评审示例：尚未收到当前 Computer 连接的 ${messagingProviderLabel("slack")} CLI 本机检查报告。没有报告应当显示等待，而不是伪装成检查中。请等待新的 daemon 检查结果，或重新检查；不要重用已消费的一次性 Computer 连接码。\n验证命令：opentag provider-cli inspect --provider slack`;
}

function longZhRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: row({
      label: "电脑",
      detailLabel: "电脑诊断",
      detail: ZH_COMPUTER_DETAIL,
      state: "passed",
      status: "ready",
      statusLabel: "就绪",
    }),
    runtime: row({
      label: runtimeLabel,
      detailLabel: "运行时诊断",
      detail: ZH_RUNTIME_DETAIL,
      state: "failed",
      status: "needs-attention",
      statusLabel: "需要关注",
    }),
    feishu: row({
      label: `${messagingProviderLabel("feishu")} CLI`,
      detailLabel: `${messagingProviderLabel("feishu")} CLI 诊断`,
      detail: zhFeishuDetail(),
      state: "failed",
      status: "install-required",
      statusLabel: "需要安装",
    }),
    slack: row({
      label: `${messagingProviderLabel("slack")} CLI`,
      detailLabel: `${messagingProviderLabel("slack")} CLI 诊断`,
      detail: zhSlackDetail(),
      state: "pending",
      status: "waiting",
      statusLabel: "等待中",
    }),
  };
}

function mixedRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Connected to Review Mac.", "passed", "ready", "Ready"),
    runtime: runtimeRow(
      runtimeLabel,
      "pending",
      "checking",
      "Checking",
      "Checking the runtime version before the sign-in step.",
    ),
    feishu: feishuRow(
      "failed",
      "needs-attention",
      "Needs attention",
      `integrity_failed: the ${messagingProviderLabel("feishu")} CLI artifact requires repair and a fresh inspection.`,
    ),
    slack: slackRow(
      "blocked",
      "stale",
      "Blocked",
      `The ${messagingProviderLabel("slack")} CLI artifact report expired; waiting for a fresh inspection.`,
    ),
  };
}

function warningRows(runtimeLabel: string): ReadinessRows {
  return {
    computer: computerRow("Connected to Review Mac.", "passed", "ready", "Ready"),
    runtime: runtimeRow(
      runtimeLabel,
      "passed",
      "ready",
      `${runtimeLabel} ready`,
      "Non-blocking warning: a newer version is available, but this installed Runtime satisfies all required capabilities. This observation remains ready.",
    ),
    feishu: feishuRow(
      "passed",
      "ready",
      `${messagingProviderLabel("feishu")} CLI ready`,
      `Compatible ${messagingProviderLabel("feishu")} CLI artifact verified locally.`,
    ),
    slack: slackRow(
      "passed",
      "ready",
      `${messagingProviderLabel("slack")} CLI ready`,
      "Non-blocking warning: global_path_not_configured. The verified managed launcher works, so the CLI remains ready.",
    ),
  };
}

export function readinessRowsForScenario(scenario: ReadinessScenario, runtime: PreviewRuntime): ReadinessRows {
  const runtimeLabel = runtimeLabelFor(runtime, scenario);
  switch (scenario) {
    case "readiness-waiting":
      return waitingRows(runtimeLabel);
    case "readiness-checking":
      return checkingRows(runtimeLabel);
    case "readiness-install-required":
      return installRequiredRows(runtimeLabel);
    case "readiness-ready":
      return readyRows(runtimeLabel);
    case "readiness-needs-attention":
      return needsAttentionRows(runtimeLabel);
    case "readiness-stale":
      return staleRows(runtimeLabel);
    case "readiness-blank":
      return blankRows(runtimeLabel);
    case "readiness-long-en":
      return longEnRows(runtimeLabel);
    case "readiness-long-zh":
      return longZhRows(runtimeLabel);
    case "readiness-mixed":
      return mixedRows(runtimeLabel);
    case "readiness-warning":
      return warningRows(runtimeLabel);
  }
}
