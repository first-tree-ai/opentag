import type { Config } from "./config.ts";
import { type FeishuClient, FeishuError } from "./feishu.ts";
import { type Incident, messageText } from "./incident.ts";

export type Log = (severity: "INFO" | "ERROR", event: string, fields: Record<string, unknown>) => void;
export type DeliveryResult = "complete" | "ignored_renotification" | "failed" | "unknown";

export async function deliver(
  incident: Incident,
  config: Pick<Config, "recipients">,
  feishu: Pick<FeishuClient, "token" | "send" | "urgent">,
  log: Log,
  signal: AbortSignal,
): Promise<DeliveryResult> {
  if (incident.state === "open" && incident.repeated) return "ignored_renotification";
  const token = await feishu.token(signal);
  let stage = "message";
  try {
    const messageId = await feishu.send(messageText(incident), token, signal);
    if (incident.state === "closed") {
      log("INFO", "relay_recovery_accepted", {});
      return "complete";
    }
    stage = "sms";
    const accepted = await feishu.urgent(messageId, config.recipients, token, signal);
    if (accepted.length !== config.recipients.length) {
      log("ERROR", "relay_delivery_failed", {
        stage,
        errorCode: "partial_sms_rejection",
        acceptedCount: accepted.length,
      });
      return "failed";
    }
    log("INFO", "relay_sms_accepted", { acceptedCount: accepted.length });
    return "complete";
  } catch (error) {
    const outcome = error instanceof FeishuError && error.outcome === "rejected" ? "failed" : "unknown";
    const errorCode = error instanceof FeishuError ? error.code : "operation_outcome_unknown";
    log("ERROR", `relay_delivery_${outcome}`, { stage, errorCode });
    return outcome;
  }
}
