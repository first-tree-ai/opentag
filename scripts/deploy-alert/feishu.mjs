import { createHmac } from "node:crypto";

const WEBHOOK_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const WEBHOOK_PATH_PREFIX = "/open-apis/bot/v2/hook/";
// Feishu answers a throttled bot with HTTP 200 and this business code.
const RATE_LIMITED_CODE = 11232;
const MAX_RETRY_DELAY_MS = 8_000;

/** Fixed wording, so a bot that uses keyword verification can match on it. */
export const ALERT_KEYWORD = "部署失败";

export class FeishuDeliveryError extends Error {
  constructor(message, { status = null, code = null, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "FeishuDeliveryError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Rejects anything but a Feishu or Lark custom bot webhook. The URL is a credential, so the error
 * names the problem and never echoes the value.
 */
export function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("FEISHU_DEPLOY_WEBHOOK_URL is not a valid URL");
  }
  if (url.protocol !== "https:" || !WEBHOOK_HOSTS.has(url.hostname) || !url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
    throw new TypeError("FEISHU_DEPLOY_WEBHOOK_URL must be an https Feishu or Lark custom bot webhook");
  }
  return url.href;
}

/** Feishu signature: HMAC-SHA256 keyed by `timestamp + "\n" + secret` over an empty message. */
export function signRequest(secret, timestampSeconds) {
  return createHmac("sha256", `${timestampSeconds}\n${secret}`).update("").digest("base64");
}

function escapeMarkdown(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function field(label, value) {
  return { is_short: true, text: { tag: "lark_md", content: `**${label}**\n${escapeMarkdown(value ?? "—")}` } };
}

function plainBlock(lines) {
  return { tag: "div", text: { tag: "plain_text", content: lines.join("\n") } };
}

function button(text, url, type) {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, url };
}

function cardTitle(alert) {
  const prefix = alert.rehearsal ? "【演练】" : "";
  return `${prefix}【${alert.environment.label}】OpenTag ${ALERT_KEYWORD}`;
}

// Values from commits and actors go in plain_text blocks, never lark_md, so nothing in them can
// render as a mention or a link.
function triggerLines(alert) {
  const ref = alert.ref ? ` · ${alert.ref}` : "";
  return [
    `提交：${alert.sha.slice(0, 7)} ${alert.commitTitle}`.trimEnd(),
    `触发：${alert.event}${ref}`,
    `触发人：${alert.actor ?? "未知"}`,
    `尝试：第 ${alert.attempt} 次`,
  ];
}

function actions(alert) {
  const buttons = [button("查看运行", alert.jobUrl ?? alert.runUrl, "danger")];
  if (alert.rootCause?.url) buttons.push(button("查看根因运行", alert.rootCause.url, "default"));
  return { tag: "action", actions: buttons };
}

/** Builds the interactive card message for one alert. */
export function buildCard(alert) {
  const elements = [
    {
      tag: "div",
      fields: [
        field("环境", alert.environment.label),
        field("工作流", alert.workflow),
        field("失败阶段", alert.phase.name),
        field("结论", alert.conclusion),
        field("失败作业", alert.jobName),
        field("失败步骤", alert.stepName),
      ],
    },
    plainBlock(triggerLines(alert)),
  ];
  if (alert.rootCause) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `**根因**：${escapeMarkdown(alert.rootCause.text)}` },
    });
  }
  if (alert.notes.length > 0) elements.push(plainBlock(alert.notes));
  elements.push(actions(alert));
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template: alert.environment.template, title: { tag: "plain_text", content: cardTitle(alert) } },
      elements,
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postOnce({ webhookUrl, body, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new FeishuDeliveryError("Feishu webhook request failed before a response arrived", {
      retryable: true,
      cause,
    });
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new FeishuDeliveryError(`Feishu webhook answered HTTP ${response.status}`, {
      status: response.status,
      retryable,
    });
  }
  // Feishu reports business failures as HTTP 200; older bots use StatusCode instead of code.
  const code = payload?.code ?? payload?.StatusCode;
  if (code !== 0) {
    const message = payload?.msg ?? payload?.StatusMessage ?? "unreadable response";
    throw new FeishuDeliveryError(`Feishu rejected the message: code ${code ?? "missing"} (${message})`, {
      status: response.status,
      code: code ?? null,
      retryable: code === RATE_LIMITED_CODE,
    });
  }
}

/**
 * Delivers one message with bounded retries. Each attempt is signed afresh, because Feishu
 * rejects a signature whose timestamp is too far from its own clock.
 */
export async function sendFeishu({
  webhookUrl,
  secret,
  message,
  fetchImpl = fetch,
  sleepImpl,
  now,
  logger,
  retries = 3,
}) {
  for (let attempt = 0; ; attempt += 1) {
    const body = { ...message };
    if (secret) {
      const timestamp = String(Math.floor(now() / 1000));
      body.timestamp = timestamp;
      body.sign = signRequest(secret, timestamp);
    }
    try {
      await postOnce({ webhookUrl, body, fetchImpl });
      logger.info("Delivered Feishu alert", { attempt: attempt + 1, signed: Boolean(secret) });
      return;
    } catch (error) {
      if (!(error instanceof FeishuDeliveryError) || !error.retryable || attempt >= retries) throw error;
      const delay = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
      logger.warn("Retrying Feishu delivery", {
        attempt: attempt + 1,
        delayMs: delay,
        status: error.status,
        code: error.code,
      });
      await sleepImpl(delay);
    }
  }
}
