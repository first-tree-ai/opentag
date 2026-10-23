import type { Config } from "./config.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid notification object");
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  return typeof value === "string"
    ? value.slice(0, limit).replace(/\p{Cc}/gu, (character) => (character === "\n" ? character : ""))
    : "";
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000) {
    throw new Error("Invalid incident timestamp");
  }
  return value;
}

function policyId(incident: Record<string, unknown>, config: Pick<Config, "project" | "policies">): string {
  const condition = object(incident.condition);
  const match =
    typeof condition.name === "string"
      ? /^projects\/([^/]+)\/alertPolicies\/(\d+)\/conditions\/\d+$/.exec(condition.name)
      : null;
  if (!match || match[1] !== config.project || !match[2] || !config.policies.has(match[2])) {
    throw new Error("Notification policy is not allowed");
  }
  if (incident.scoping_project_id !== undefined && incident.scoping_project_id !== config.project) {
    throw new Error("Notification project is not allowed");
  }
  return match[2];
}

export function parseIncident(payload: unknown, config: Pick<Config, "project" | "policies">) {
  const body = object(payload);
  if (body.version !== "1.2") throw new Error("Unsupported notification version");
  const incident = object(body.incident);
  const policy = policyId(incident, config);
  const id = incident.incident_id;
  const state = incident.state;
  const started = timestamp(incident.started_at);
  const ended = state === "closed" ? timestamp(incident.ended_at) : undefined;
  if (typeof id !== "string" || !/^[\w.-]{1,160}$/.test(id)) throw new Error("Invalid incident identity");
  if (state !== "open" && state !== "closed") throw new Error("Invalid incident state");
  if (ended !== undefined && ended < started) throw new Error("Invalid end time");
  if (incident.renotify !== undefined && typeof incident.renotify !== "boolean") throw new Error("Invalid repeat flag");
  return {
    id,
    state,
    policyId: policy,
    started,
    ended,
    repeated: incident.renotify === true,
    policyName: text(incident.policy_name, 180) || policy,
    resource: text(incident.resource_display_name ?? incident.resource_name, 240),
    summary: text(incident.summary, 1_200),
    url: `https://console.cloud.google.com/monitoring/alerting/incidents/${encodeURIComponent(id)}?project=${config.project}`,
  };
}

export type Incident = ReturnType<typeof parseIncident>;

export function messageText(incident: Incident): string {
  const format = (time: number) =>
    new Date(time * 1000).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  const lines = [
    `[生产${incident.state === "open" ? "告警" : "恢复"}] ${incident.policyName}`,
    `资源：${incident.resource || "见 GCP 详情"}`,
    `开始：${format(incident.started)}（北京时间）`,
    ...(incident.ended ? [`恢复：${format(incident.ended)}（北京时间）`] : []),
    `开始 UTC：${new Date(incident.started * 1000).toISOString()}`,
    `事故：${incident.id}`,
    incident.summary,
    incident.url,
  ];
  return lines.filter(Boolean).join("\n");
}
